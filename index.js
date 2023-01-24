/*
 *  _   _ _   _              ____  _ _     _
 * | | | | |_| |_ _ __      / ___|| (_) __| | ___ _ __
 * | |_| | __| __| '_ \ ____\___ \| | |/ _` |/ _ \ '__|
 * |  _  | |_| |_| |_) |_____|__) | | | (_| |  __/ |
 * |_| |_|\__|\__| .__/     |____/|_|_|\__,_|\___|_|
 *               |_|
 *
 * A homebridge plugin
 *
 */

var request = require('request');
var Service, Characteristic;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    HomebridgeAPI = homebridge;

    homebridge.registerAccessory('homebridge-http-slider', 'Slider', SliderAccessory);
};

function SliderAccessory(log, config) {
    this.log = log;
    log('Starting http-slider');
    this.config = config;
    this.name = config.name;

    this.cacheDirectory = HomebridgeAPI.user.persistPath();
    this.storage = require('node-persist');
    this.storage.initSync({dir:this.cacheDirectory, forgiveParseErrors: true});

    if (typeof(this.config.thermo_range_low) !== 'number') {
        this.config.thermo_range_low = 0;
    }
    if (typeof(this.config.thermo_range_high) !== 'number') {
        this.config.thermo_range_high = 100;
    }

    if (this.config.service !== 'Thermostat') {
        this.range_low = 0;
        this.range_high = 100;
    } else {
        this.range_low = this.config.thermo_range_low;
        this.range_high = this.config.thermo_range_high;
    }
}

SliderAccessory.prototype = {

    getServices: function() {
        var services = [];

        var info = new Service.AccessoryInformation();
        info.setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, 'Programmed by Marvin Dostal')
            .setCharacteristic(Characteristic.Model, '-')
            .setCharacteristic(Characteristic.FirmwareRevision, '-')
            .setCharacteristic(Characteristic.SerialNumber, '-');

        services.push(info);

        startRequestInterval(this.config.request_interval || 1500);

        if (this.config.service === 'Lightbulb') {
            this.sliderService = new Service.Lightbulb(this.name + ' Slider');
            this.sliderCharacteristic = Characteristic.Brightness;

            this.sliderService
                .getCharacteristic(Characteristic.On)
                //.on('get', this.getAlwaysOn)
                .on('set', this.setAlwaysOn.bind(this));
            this.sliderService
                .getCharacteristic(Characteristic.Brightness)
                .on('get', this.getPercentage.bind(this))
                .on('set', this.setPercentage.bind(this));
        } else if (this.config.service === 'Fan') {
            this.sliderService = new Service.Fan(this.name + ' Slider');
            this.sliderCharacteristic = Characteristic.RotationSpeed;

            this.sliderService
                .getCharacteristic(Characteristic.On)
                .on('get', this.getAlwaysOn)
                .on('set', this.setAlwaysOn.bind(this));
            this.sliderService
                .getCharacteristic(Characteristic.RotationSpeed)
                .on('get', this.getPercentage.bind(this))
                .on('set', this.setPercentage.bind(this));
        } else if (this.config.service === 'Thermostat') {
            this.sliderService = new Service.Thermostat(this.name + ' Slider');
            this.sliderCharacteristic = Characteristic.TargetTemperature;

            this.sliderService
                .getCharacteristic(Characteristic.TargetTemperature)
                .setProps({
                    maxValue: this.config.thermo_range_high,
                    minValue: this.config.thermo_range_low
                })
                .on('get', this.getPercentage.bind(this))
                .on('set', this.setPercentage.bind(this));
        }

        var cachedOnState = this.storage.getItemSync(this.name) || false;
        this.sliderService.setCharacteristic(Characteristic.On, cachedOnState);
        var cachedBrightness = this.storage.getItemSync(this.name + ' Brightness') || 0;
        this.sliderService.setCharacteristic(Characteristic.Brightness, cachedBrightness);
        if(cachedBrightness == 0) this.sliderService.setCharacteristic(Characteristic.On, false);

        services.push(this.sliderService);

        return services;
    },

    getAlwaysOn: function(callback) {
        var cached_state = this.storage.getItemSync(this.name) || false;
        this.log('Getting state ON ' + this.name + ' ' + this.storage + ' ' + cached_state);
        callback(null, cached_state);
    },

    setAlwaysOn: function(state, callback) {
        callback(null);
        this.log('Storing state ON ' + this.name + ' ' + this.storage + ' ' + state);
        this.storage.setItemSync(this.name, state);
        reset(this.sliderService, Characteristic.On, state);
    },

    getPercentage: function(callback) {
        var cached_state = this.storage.getItemSync(this.name + ' Brightness') || 0;
        this.log('Getting state BRIGHTNESS ' + this.name + ' ' + this.storage + ' ' + cached_state);
        callback(null, cached_state);
    },

    setPercentage: function(state, callback) {
        var numberOfStates = this.config.http_states.length;
        var range = this.range_high - this.range_low;
        var percentage = state / range;

        var newState = percentageToSlider(percentage , numberOfStates);

        setNextRequest(this.config.http_states[newState]);

        var interval = range / (numberOfStates - 1);
        var section = (interval * newState) + this.range_low;

        this.log('Storing state ' + section);
        this.storage.setItemSync(this.name + ' Brightness', section);
        callback(null, section);
        reset(this.sliderService, this.sliderCharacteristic, section, 500);
    }
};

/**
 * Calculates the slider position in a slider with a specific number of states.
 * @param {float} percentage
 * @param {int} numberOfStates
 * @return {int} zero indexed state
 */
var percentageToSlider = function(percentage, numberOfStates) {
    if (percentage <= 0.0)
        return 0;
    else if (percentage >= 1.0)
        return numberOfStates - 1;

    if (numberOfStates === 1)
        return numberOfStates - 1;

    var interval = 1 / (numberOfStates - 1);
    var interval_half = interval / 2;

    // avg. running time of n/2. propably O(n logn) possible
    for (var i=0; i < numberOfStates; i++)
        if (((i*interval)+interval_half) > percentage)
            return i;

    // it should never get here, but for correctness; why not?
    return numberOfStates - 1;
};

/**
 * Resets a characteristic of a service by using a getter callback with a
 * specific delay
 *
 * @param {Service} service The service
 * @param {Characteristic} characterisitc The characteristic of the service to reset
 * @param {number} delay The delay when the reset takes place
 */
var reset = function(service, characteristic, newValue, delay){
    if (!delay) {
        // default value without ECMAscript 6 features
        delay = 1000;
    }

    setTimeout(function() {
        service.getCharacteristic(characteristic).updateValue(newValue);
    }, delay);
};

/*
 * Prevents a fast succession of http get requests
 */
var callrequest = false;
var callhttp = '';

var setNextRequest = function(url) {
    callhttp = url;
    callrequest = true;
};

var startRequestInterval = function(interval) {
    setInterval(function() {
        if (callrequest) {
            callrequest = false;
            if (callhttp !== '')
                request(callhttp, function() {});
        }
    }, interval);
};
