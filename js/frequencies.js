
var oscs = [];
var audioctx = [];

function createOsc(frequency) {

    var audioCtx = new (window.AudioContext || window.webkitAudioContext || window.mozAudioContext || window.oAudioContext || window.msAudioContext)();
    var analyser = audioCtx.createAnalyser();
    var oscillator = audioCtx.createOscillator();
    var panner = audioCtx.createStereoPanner();
    var volume = audioCtx.createGain();

    oscillator.type = 'sine';

    if (parseInt(frequency) > 14000) {
        oscillator.frequency.setValueAtTime(14000, audioCtx.currentTime);
    }
    else {
        oscillator.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    }

    oscillator.connect(panner);
    panner.connect(volume);
    volume.connect(audioCtx.destination);

    panner.pan.value = 0;
    volume.gain.value = 1;

    if (parseInt(frequency) <= 120) {
        volume.gain.value = -0.5;
    }

    oscillator.start();

    oscs.push(oscillator);
    audioctx.push(audioCtx);
}

function play(frequencyList, description) {
    stop();
    if (description) {
        var synth = window.speechSynthesis;
        var speach = new SpeechSynthesisUtterance(`Playing ${description}`);
    }
    var frequencies = frequencyList ?? document.querySelector("#frequencies").value;
    if (frequencies) {
        document.querySelector("#play").setAttribute("disabled", "");
        var array = frequencies.split(',');
        for (let index = 0; index < array.length; index++) {
            const element = array[index];
            createOsc(element);
        }
    }
}

function stop() {
    if (oscs && oscs.length > 0) {
        for (let index = 0; index < oscs.length; index++) {
            oscs[index].stop();
            audioctx[index].close();
        }
        oscs = [];
        audioctx = [];
        document.querySelector("#play").removeAttribute("disabled");
    }
}

function enablePlay(e) {
    document.querySelector("#play").removeAttribute("disabled");
    if (e.key === 'Enter' || e.keyCode === 13) {
        play();
    }
}