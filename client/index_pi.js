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

function connectElgatoStreamDeckSocket(inPort, inPropertyInspectorUUID, inRegisterEvent, _inInfo, inActionInfo) {
    console.log("HELLO!")
    if (websocket) {
        websocket.close();
        websocket = null;
    }

    let actionInfo = JSON.parse(inActionInfo);

    // Store settings
    settings = actionInfo['payload']['settings'];

    // Retrieve language
    // let language = info['application']['language'];

    // Retrieve action identifier
    let action = actionInfo['action'];
    console.log("pi/client action: " + action);

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
            let jsonObj = JSON.parse(evt.data);
            let event = jsonObj['event'];

            console.log(JSON.stringify(jsonObj));
            console.log("pi/client received event " + event);

            switch (event) {
                case "didReceiveGlobalSettings":
                    globalSettings = jsonObj['payload']['settings'];
                    console.log("pi/client received global settings: " + JSON.stringify(globalSettings));
                    break

                case "didReceiveSettings":
                    settings = jsonObj['payload']['settings'];
                    console.log("pi/client received plugin settings: " + JSON.stringify(settings));

                    if (settings['label']) {
                        document.getElementById('label').value = settings['label'];
                    }

                    // if not set in this button, copy the last from global
                    let accountId = settings['accountId'];
                    if (accountId === undefined) {
                        accountId = globalSettings['accountId'];
                        settings['accountId'] = accountId;
                        console.log("set missing account id from last global settings");
                        setButtonSettings();
                    }
                    let accessToken = settings['accessToken'];
                    if (accessToken === undefined) {
                        accessToken = globalSettings['accessToken'];
                        settings['accessToken'] = accessToken;
                        console.log("set missing access token from last global settings");
                        setButtonSettings();
                    }

                    console.log("pi/client has settings: " + JSON.stringify(settings));

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
                    console.log("pi/client title changed")
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
    console.log("called update()");
    updateClients()
        .then(ok => {
            console.log(`result of client update: ${ok}`);
            if (ok) {
                let cid = settings["clientId"];
                if (cid !== undefined) {
                    console.log(`setting client back to ${cid}`);
                    getClientsHandle().value = cid;
                } else {
                    console.log("no project in settings");
                }
            } else {
                console.log("projects update not ok");
            }
        })
        .catch(error => {
            console.log(`caught exception: ${error}`);
            setValidAccessToken(false);
        })
}

// -----------------------------------------------------------------------------------------------------------------------

// throw error is invalid access token or account id
// return true if we updated the project list
// return false if we somehow failed to update the project list, such as empty or missing data
async function updateClients() {
    console.log("called updateProjects()");
    let accountId = settings['accountId'];
    let accessToken = settings['accessToken'];

    if (!accountId || !accessToken) {
        console.log("missing id or token");
        setValidAccessToken(false);
        return false;
    }

    console.log("have both an id and access token; will try to get clients");

    return getClients(accountId, accessToken)
        .then(response => {
            if (response.status !== 200) {
                console.log(response.text());
                throw new Error(`bad rc=${response.status}`);
            } else {
                console.log(`response ${response.status}`);
                setValidAccessToken(true);
                return response.json();
            }
        })
        .then(json => {
            return updateClientsNow(json);
        })
        .catch(error => {
            console.log(`failed to fetch projects: ${error}`);
            setValidAccessToken(false);
            throw error;
        })
}

function getClients(accountId, accessToken) {
    console.log("called getProjects()");
    // remove existing projects as soon as we try to get new ones
    clearClients();

    let headers = getHeaders(accountId, accessToken);

    let url = `${apiUrl}/clients?is_active=true&per_page=100`;
    return fetch(url, {method: 'GET', headers: headers});  // return a Promise
}

function getClientsHandle() {
    return document.getElementById('clientId');
}

function clearClients() {
    console.log("called clearProjects()");
    let projectSelect = getClientsHandle();
    while (projectSelect.options.length) projectSelect.remove();
    return projectSelect;
}

function updateClientsNow(data) {
    console.log("called updateClientsNow()");
    if (data == null) {
        setValidAccessToken(false);
        console.log("null data in updateClientsNow");
        return false;
    } else if (data === {}) {
        setValidAccessToken(false);
        console.log("no useful data in updateClientsNow: " + JSON.stringify(data));
        return false;
    } else if (data["clients"] === undefined) {
        setValidAccessToken(false);
        console.log("no 'projects' data in updateClientsNow: " + JSON.stringify(data));
        return false;
    } else {
        console.log("processing projects");

        let clientSelect = clearClients();
        if (settings["clientId"] === undefined) {
            // if no current project selected, then put a blank entry first??
            console.log("adding <select> to client list");
            clientSelect.add(new Option("<select>", 0));
        }
        data["clients"].forEach(project => {
            clientSelect.add(new Option(project['name'], project["id"]));
        });

        setValidAccessToken(true);

        console.log("done with updateClientsNow");
        return true;
    }
}

function setValidAccessToken(isValid) {
    if (isValid) {
        console.log("showing selectors");
        Array.from(document.getElementsByClassName("validAccess")).forEach(elem => elem.classList.remove("hidden"));
        Array.from(document.getElementsByClassName("invalidAccess")).forEach(elem => elem.classList.add("hidden"));
    } else {
        console.log("hiding selectors");
        Array.from(document.getElementsByClassName("validAccess")).forEach(elem => elem.classList.add("hidden"));
        Array.from(document.getElementsByClassName("invalidAccess")).forEach(elem => elem.classList.remove("hidden"));
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

function setLabel() {
    let label = document.getElementById('label').value;
    console.log(`set label to ${label}`);
    settings["label"] = label;
    //update();
    setButtonSettings(uuid)
}

function setClient() {
    let clientId = document.getElementById('clientId').value;
    console.log(`set client ID to ${clientId}`);
    settings["clientId"] = clientId;
    //update();
    setButtonSettings(uuid)
}

// -----------------------------------------------------------------------------------------------------------------------

function requestGlobalSettings(forUUID) {
    // Request the global settings of the plugin. Will receive a 'didReceiveGlobalSettings' event/message.
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({
        event: 'getGlobalSettings',
        context: forUUID
    }))
    console.log("pi/client requested global settings");
}

function setGlobalSettings(forUUID) {
    // Setting these will trigger a 'didReceiveGlobalSettings' event/message IN THE PLUGIN with a copy of the settings.
    if (websocket && websocket.readyState) {
        let payload = {
            accountId: globalSettings['accountId'],
            accessToken: globalSettings['accessToken']
        };
        websocket.send(JSON.stringify({event: 'setGlobalSettings', context: forUUID, payload: payload}));
        console.log("pi/client set global settings: " + JSON.stringify(payload));
    }
}

function requestButtonSettings(forUUID) {
    // Request the global settings of the plugin. Will receive a 'didReceiveGlobalSettings' event/message.
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({event: 'getSettings', context: forUUID}));
    console.log("pi/client requested settings");
}

function setButtonSettings(forUUID) {
    // Setting these will trigger a 'didReceiveSettings' event/message IN THE PLUGIN with a copy of the settings.
    if (websocket && websocket.readyState) {
        let payload = {
            type: "client",
            accountId: settings['accountId'],
            accessToken: settings['accessToken'],
            label: settings['label'],
            clientId: settings['clientId']
        };
        websocket.send(JSON.stringify({event: 'setSettings', context: forUUID, payload: payload}));
        console.log("pi/client set settings: " + JSON.stringify(payload));
    }
}

function getHeaders(accountId, accessToken) {
    return new Headers({
        "User-Agent": "streamdeck ${streamDeckVersion} com.wolfzoo.harvest plugin ${pluginVersion}",
        "Authorization": "Bearer " + accessToken,
        "Harvest-Account-ID": accountId,
        'Content-Type': 'application/json'
    });
}
