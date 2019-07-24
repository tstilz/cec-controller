const { exec, spawn } = require('child_process');
const { EventEmitter } = require('events');
const getKeyName = require('./keymap');

module.exports = class Client
{
	constructor(opts)
	{
		if(!(typeof opts === 'object')) opts = {};

		this.osdString = (typeof opts.osdString === 'string'
			&& opts.osdString.length < 13) ? opts.osdString : 'CEC-Control';
		this.type = (typeof opts.type === 'string') ? opts.type.charAt(0) : 'p';
		this.hdmiPorts = (opts.hdmiPorts > 0) ? opts.hdmiPorts : 3;
		this.broadcast = (opts.broadcast === false) ? false : true;

		this.controlledDevice = 'dev0';
		this.sourceNumber = 0;
		this.keyReleaseTimeout = null;

		this.cec = { ...EventEmitter.prototype, ...this._getGlobalFunctions() };
		this.myDevice = null;

		this._scanDevices();

		return this.cec;
	}

	_scanDevices()
	{
		exec(`echo scan | cec-client -s -t ${this.type} -o ${this.osdString} -d 1`,
			{ maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) =>
		{
			if(error) return this.cec.emit('error', new Error('App cec-client had an error!'));

			const scannedDevices = this._parseScanOutput(String(stdout));
			const scannedKeys = Object.keys(scannedDevices);
			if(scannedKeys.length === 0)
				return this.cec.emit('error', new Error('CEC scan did not find any devices!'));

			this.myDevice = this._getMyDevice(scannedDevices);
			if(!this.myDevice)
				return this.cec.emit('error', new Error(`Could not obtain this CEC adapter info!`));

			this.cec = { ...this.cec, ...scannedDevices };

			for(var deviceId in this.cec)
				this.cec[deviceId] = { ...this.cec[deviceId], ...this._getDeviceFunctions(deviceId) };

			this._createClient();
		});
	}

	_parseScanOutput(outStr)
	{
		var devicesObject = {};
		var outArray = outStr.split('device #');

		outArray.forEach(device =>
		{
			var devName = device.substring(device.indexOf(':') + 2, device.indexOf('\n'));
			var devId = device.substring(0, device.indexOf(':'));

			if(!devName || !devId) return;

			devicesObject['dev' + devId] = { name: devName, logicalAddress: devId };

			var data = device.split('\n');

			for(var i = 1; i < data.length; i++)
			{
				var params = data[i].split(':');
				if(params.length !== 2) break;

				var key = params[0].toLowerCase();
				key = key.split(' ');

				if(key.length > 1)
				{
					for(var j = 1; j < key.length; j++)
					{
						key[j] = key[j].charAt(0).toUpperCase() + key[j].slice(1);
					}
				}

				key = key.toString().replace(/,/g, '');

				var value = params[1].trimLeft();
				devicesObject['dev' + devId][key] = value;
			}
		});

		return devicesObject;
	}

	_getMyDevice(devices)
	{
		var keys = Object.keys(devices);

		for(var key of keys)
		{
			var currObj = devices[key];

			if(typeof currObj !== 'object')
				continue;

			if(currObj.hasOwnProperty('osdString') && currObj.osdString === this.osdString)
			{
				return key;
			}
		}

		return null;
	}

	_createClient()
	{
		this.doneInit = false;
		this.cecClient = spawn('cec-client',
			['-t', this.type, '-o', this.osdString, '-d', 8],
			{ stdio: ['pipe', 'pipe', 'ignore'] });

		this.cecClient.stdin.setEncoding('utf8');
		this.cecClient.stdout.on('data', (data) => this._parseClientOutput(String(data)));
		this.cecClient.once('close', (code) =>
		{
			if(this.doneInit) this._createClient();
			else this.cec.emit('error', new Error(`App cec-client exited with code: ${code}`));
		});
	}

	_parseClientOutput(line)
	{
		if(!this.doneInit)
		{
			if(this.myDevice && line.includes('waiting for input'))
			{
				this.doneInit = true;
				this.cec.emit('ready');
			}

			return;
		}

		if(line.startsWith('power status:'))
		{
			var logicalAddress = this.cec[this.controlledDevice].logicalAddress;
			var value = this._getLineValue(line);

			this.cec[this.controlledDevice].powerStatus = value;
			this.cec.emit(`${logicalAddress}:powerStatus`, value);
		}
		else if(line.startsWith('active source:')
			|| (line.startsWith('logical address') && line.includes('active')))
		{
			var logicalAddress = this.cec[this.myDevice].logicalAddress;
			var value = null;

			if(line.startsWith('logical address')) value = (line.includes('not')) ? 'no' : 'yes';
			else value = this._getLineValue(line);

			this.cec[this.myDevice].activeSource = value;
			this.cec.emit(`${logicalAddress}:activeSource`, value);
		}
		else if(line.startsWith('TRAFFIC:') && line.includes('>>'))
		{
			var destAddress = this.cec[this.myDevice].logicalAddress;
			var value = this._getLineValue(line).toUpperCase();

			if(line.includes(`>> 0${destAddress}:44:`))
			{
				this.cec.emit('keypress', getKeyName(value));

				if(!this.keyReleaseTimeout)
					this.cec.emit('keydown', getKeyName(value));
			}
			else if(line.includes(`>> 0${destAddress}:8b:`))
			{
				if(this.keyReleaseTimeout)
					clearTimeout(this.keyReleaseTimeout);

				this.keyReleaseTimeout = setTimeout(() =>
				{
					this.cec.emit('keyup', getKeyName(value));
					this.keyReleaseTimeout = null;
				}, 600);
			}
		}
	}

	_getLineValue(line)
	{
		var lineArray = line.split(':');
		return lineArray[lineArray.length - 1].trim();
	}

	_getDeviceFunctions(deviceId)
	{
		var func = {
			turnOn: this.changePower.bind(this, deviceId, 'on'),
			turnOff: this.changePower.bind(this, deviceId, 'standby')
		};

		if(this.cec[deviceId].name === 'TV')
		{
			func.changeSource = (number) =>
			{
				if(isNaN(number) || number < 1)
				{
					this.sourceNumber = (this.sourceNumber < this.hdmiPorts) ? this.sourceNumber + 1 : 1;
					number = this.sourceNumber;
				}

				var srcAddress = this.cec[this.myDevice].logicalAddress;
				var destAddress = (this.broadcast === false) ? this.cec[deviceId].logicalAddress : 'F';

				return this.command(`tx ${srcAddress}${destAddress}:82:${number}0:00`, null);
			}
		}

		return func;
	}

	_getGlobalFunctions()
	{
		return {
			setActive: this.changeActive.bind(this, 'yes'),
			setInactive: this.changeActive.bind(this, 'no'),
			volumeUp: this.command.bind(this, 'volup', null),
			volumeDown: this.command.bind(this, 'voldown', null),
			mute: this.command.bind(this, 'mute', null),
			command: (args) => { return this.command(args, null); }
		}
	}

	command(action, logicalAddress)
	{
		return new Promise((resolve, reject) =>
		{
			if(!action || typeof action !== 'string') resolve(null);
			else
			{
				if(!logicalAddress) this.cecClient.stdin.write(action);
				else this.cecClient.stdin.write(`${action} ${logicalAddress}`);

				this.cecClient.stdout.once('data', () => resolve(true));
			}
		});
	}

	changePower(deviceId, powerStatus)
	{
		this.controlledDevice = deviceId;

		return new Promise((resolve, reject) =>
		{
			this.getStatus(deviceId).then(value =>
			{
				if(value === null) resolve(null);
				else if(value === powerStatus) resolve(powerStatus);
				else
				{
					this.command(powerStatus, this.cec[deviceId].logicalAddress);

					var timedOut = false;
					var actionTimeout = setTimeout(() => timedOut = true, 40000);

					var waitPower = () =>
					{
						this.getStatus(deviceId).then(value =>
						{
							if(value !== powerStatus && !timedOut)
								return waitPower();

							clearTimeout(actionTimeout);

							if(timedOut) resolve(null);
							else resolve(powerStatus);
						});
					}

					waitPower();
				}
			});
		});
	}

	changeActive(isActiveSource)
	{
		return new Promise((resolve, reject) =>
		{
			var activeSource = (isActiveSource === 'yes' || isActiveSource === true) ? 'yes' : 'no';

			this.getActive(this.myDevice).then(value =>
			{
				if(value === null) resolve(null);
				else if(value === activeSource) resolve(activeSource);
				else
				{
					var action = (activeSource === 'yes') ? 'as' : 'is';
					this.command(action, null);

					var timedOut = false;
					var actionTimeout = setTimeout(() => timedOut = true, 15000);

					var waitActive = () =>
					{
						this.getActive(this.myDevice).then(value =>
						{
							if(value !== activeSource && !timedOut)
								return waitActive();

							clearTimeout(actionTimeout);

							if(timedOut) resolve(null);
							else resolve(activeSource);
						});
					}

					waitActive();
				}
			});
		});
	}

	getStatus(deviceId)
	{
		this.controlledDevice = deviceId;

		return new Promise((resolve, reject) =>
		{
			var logicalAddress = this.cec[deviceId].logicalAddress;

			var statusTimeout = setTimeout(() =>
			{
				this.cec[deviceId].powerStatus = 'Unknown';
				this.cec.emit(`${logicalAddress}:powerStatus`, null);
			}, 10000);

			this.command(`pow ${logicalAddress}`);
			this.cec.once(`${logicalAddress}:powerStatus`, (value) =>
			{
				clearTimeout(statusTimeout);
				resolve(value);
			});
		});
	}

	getActive(deviceId)
	{
		this.controlledDevice = deviceId;

		return new Promise((resolve, reject) =>
		{
			var logicalAddress = this.cec[deviceId].logicalAddress;

			var activeTimeout = setTimeout(() =>
			{
				this.cec[deviceId].activeSource = 'Unknown';
				this.cec.emit(`${logicalAddress}:activeSource`, null);
			}, 10000);

			this.command(`ad ${logicalAddress}`);
			this.cec.once(`${logicalAddress}:activeSource`, (value) =>
			{
				clearTimeout(activeTimeout);
				resolve(value);
			});
		});
	}
}
