const apiUrl = 'https://api.harvestapp.com/v2'

// Global Web Socket
let websocket = null;

// Global Plugin Settings. Data will be saved securely to the Keychain on macOS and the
// Credential Store on Windows. Used to save tokens that should be available to every
// action in the plugin.
let globalSettings = {};

// Settings for this Plugin instance.
let settings = {};

let uuid;

// noinspection JSUnusedLocalSymbols
function connectElgatoStreamDeckSocket(inPort, inPropertyInspectorUUID, inRegisterEvent, _inInfo, inActionInfo) {
    if (websocket) {
        websocket.close();
        websocket = null;
    }

    let actionInfo = JSON.parse(inActionInfo);

    // Save global settings
    settings = actionInfo['payload']['settings'];

    // Connect to Stream Deck
    websocket = new WebSocket('ws://127.0.0.1:' + inPort);

    uuid = inPropertyInspectorUUID;

    websocket.onopen = function () {
        // WebSocket is connected, register the Property Inspector
        const json = {
            event: inRegisterEvent,
            uuid: inPropertyInspectorUUID
        };
        websocket.send(JSON.stringify(json));

        requestGlobalSettings(uuid);
        requestButtonSettings(uuid);
    };

    websocket.onclose = function (evt) {
        console.log('[STREAM DECK]***** WEBSOCKET CLOSED **** reason:', evt);
    };

    websocket.onerror = function (evt) {
        console.warn('WEBSOCKET ERROR', evt, evt.data);
    };

    websocket.onmessage = function (evt) {
        try {
            let jsonObj = JSON.parse(evt.data)
            let event = jsonObj['event']

            console.log(JSON.stringify(jsonObj))
            console.log("pi/daily received event " + event)

            switch (event) {
                case "didReceiveGlobalSettings":
                    globalSettings = jsonObj['payload']['settings']
                    console.log("pi/daily received global settings: " + JSON.stringify(globalSettings))
                    break

                case "didReceiveSettings":
                    settings = jsonObj['payload']['settings']
                    console.log("pi/daily received plugin settings: " + JSON.stringify(settings))

                    if (settings['label']) {
                        document.getElementById('label').value = settings['label'];
                    }

                    document.getElementById('idField').innerHTML = uuid

                    // if not set in this button, copy the last from global
                    let accountId = settings['accountId'];
                    if (accountId === undefined) {
                        accountId = globalSettings['accountId'];
                        settings['accountId'] = accountId
                        console.log("set missing account id from last global settings");
                    }
                    let accessToken = settings['accessToken'];
                    if (accessToken === undefined) {
                        accessToken = globalSettings['accessToken'];
                        settings['accessToken'] = accessToken
                        console.log("set missing access token from last global settings");
                    }

                    console.log("pi/daily has settings: " + JSON.stringify(settings));
                    setButtonSettings();

                    if (accountId !== undefined) {
                        document.getElementById('accountId').value = accountId;
                    }
                    if (accessToken !== undefined) {
                        document.getElementById('accessToken').value = accessToken;
                    }
                    if (accountId !== undefined && accessToken !== undefined) {
                        console.log("have an account ID and access token");
                        update();
                    } else {
                        console.log("no access/id yet");
                    }
                    break

                case 'applicationDidLaunch':
                    break

                case 'applicationDidTerminate':
                    break

                case 'titleParametersDidChange':
                    console.log("pi/daily title changed")
                    break

                default:
                    console.log("unhandled event: " + event)
                    break
            }
        } catch (error) {
            console.trace('Could not parse incoming message', error, evt.data);
        }
    }
}


// -----------------------------------------------------------------------------------------------------------------------

function update() {
    console.log("pi/daily called update()");
    getWeeklyTotal()
        .then(ok => {
            console.log("result of update: " + JSON.stringify(ok));
        })
        .catch(error => {
            console.log(`caught exception: ${error}`);
            setValidAccessToken(false);
            showAlert(uuid)
        })
}

// -----------------------------------------------------------------------------------------------------------------------

// throw error is invalid access token or account id
// return true if we updated the project list
// return false if we somehow failed to update the project list, such as empty or missing data
async function getWeeklyTotal() {
    console.log("called getWeeklyTotal()");
    let accountId = settings['accountId'];
    let accessToken = settings['accessToken'];

    if (!accountId || !accessToken) {
        console.log("missing id or token");
        setValidAccessToken(false);
        showAlert(uuid)
        return false;
    }

    return getReport(accountId, accessToken)
        .then(response => {
            if (response.status !== 200) {
                console.log(response.text())
                throw new Error(`bad rc=${response.status}`);
            } else {
                console.log(`response ${response.status}`);
                setValidAccessToken(true);
                return response.json();
            }
        })
        .catch(error => {
            console.log(`failed to fetch projects: ${error}`);
            setValidAccessToken(false);
            throw error;
        });
}

function getReport(accountId, accessToken) {
    console.log("called getReport()");

    let headers = getHeaders(accountId, accessToken)

    const mondayDateObj = new Date();
    mondayDateObj.setDate(mondayDateObj.getDate() - (mondayDateObj.getDay() + 6) % 7);
    let from = mondayDateObj.getFullYear() +
            ('0' + (mondayDateObj.getMonth() + 1)).slice(-2) +
            ('0' + mondayDateObj.getDate()).slice(-2)
    const toDateObj = new Date();
    let to = toDateObj.getFullYear() +
        ('0' + (toDateObj.getMonth() + 1)).slice(-2) +
        ('0' + toDateObj.getDate()).slice(-2)

    let url = `${apiUrl}/reports/time/clients?from=${from}&to=${to}&per_page=100`;
    console.log(`GET ${url}`)
    return fetch(url, {method: 'GET', headers: headers});  // return a Promise
}

function setValidAccessToken(isValid) {
    if (isValid) {
        console.log("showing selectors")
        setButtonSettings(uuid)
        Array.from(document.getElementsByClassName("validAccess")).forEach(elem => elem.classList.remove("hidden"))
        Array.from(document.getElementsByClassName("invalidAccess")).forEach(elem => elem.classList.add("hidden"))
    } else {
        console.log("hiding selectors")
        Array.from(document.getElementsByClassName("validAccess")).forEach(elem => elem.classList.add("hidden"))
        Array.from(document.getElementsByClassName("invalidAccess")).forEach(elem => elem.classList.remove("hidden"))
    }
}

// -----------------------------------------------------------------------------------------------------------------------

function setAccountId() {
    let accountId = document.getElementById('accountId').value;
    console.log("Entered account ID " + accountId);
    globalSettings['accountId'] = accountId;
    settings['accountId'] = accountId;
    setGlobalSettings(uuid);
    setButtonSettings(uuid);
    update();
}

function setAccessToken() {
    let accessToken = document.getElementById('accessToken').value;
    console.log("Entered access token " + accessToken);
    globalSettings['accessToken'] = accessToken;
    settings['accessToken'] = accessToken;
    setGlobalSettings(uuid);
    setButtonSettings(uuid);
    update();
}

// -----------------------------------------------------------------------------------------------------------------------

function requestGlobalSettings(forUUID) {
    // Request the global settings of the plugin. Will receive a 'didReceiveGlobalSettings' event/message.
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({
        event: 'getGlobalSettings',
        context: forUUID
    }))
    console.log("pi/daily requested global settings");
}

function setGlobalSettings(forUUID) {
    // Setting these will trigger a 'didReceiveGlobalSettings' event/message IN THE PLUGIN with a copy of the settings.
    if (websocket && websocket.readyState) {
        let payload = {
            accountId: globalSettings['accountId'],
            accessToken: globalSettings['accessToken']
        }
        websocket.send(JSON.stringify({event: 'setGlobalSettings', context: forUUID, payload: payload}))
        console.log("pi/daily set global settings: " + JSON.stringify(payload));
    }
}

function requestButtonSettings(forUUID) {
    // Request the global settings of the plugin. Will receive a 'didReceiveGlobalSettings' event/message.
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({event: 'getSettings', context: forUUID}))
    console.log("pi/daily requested settings");
}

function setButtonSettings(forUUID) {
    // Setting these will trigger a 'didReceiveSettings' event/message IN THE PLUGIN with a copy of the settings.
    if (websocket && websocket.readyState) {
        let payload = {
            type: "daily",
            accountId: settings['accountId'],
            accessToken: settings['accessToken'],
            label: settings['label']
        }
        websocket.send(JSON.stringify({event: 'setSettings', context: forUUID, payload: payload}))
        console.log("pi/daily set settings: " + JSON.stringify(payload));
    }
}

function getHeaders(accountId, accessToken) {
    return new Headers({
        "User-Agent": "streamdeck ${streamDeckVersion} com.wolfzoo.harvest plugin ${pluginVersion}",
        "Authorization": "Bearer " + accessToken,
        "Harvest-Account-ID": accountId,
        'Content-Type': 'application/json'
    })
}
