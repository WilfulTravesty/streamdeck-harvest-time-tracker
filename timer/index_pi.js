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

    // Retrieve action identifier
    let action = actionInfo['action'];

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
            console.log("pi received event " + event)

            switch (event) {
                case "didReceiveGlobalSettings":
                    globalSettings = jsonObj['payload']['settings']
                    console.log("pi received global settings: " + JSON.stringify(globalSettings))
                    break

                case "didReceiveSettings":
                    settings = jsonObj['payload']['settings']
                    console.log("pi received plugin settings: " + JSON.stringify(settings))

                    if (settings['label']) {
                        document.getElementById('label').value = settings['label'];
                    }

                    // if not set in this button, copy the last from global
                    let accountId = settings['accountId'];
                    if (accountId === undefined) {
                        accountId = globalSettings['accountId'];
                        settings['accountId'] = accountId
                        console.log("set missing account id from last global settings");
                        setButtonSettings();
                    }
                    let accessToken = settings['accessToken'];
                    if (accessToken === undefined) {
                        accessToken = globalSettings['accessToken'];
                        settings['accessToken'] = accessToken
                        console.log("set missing access token from last global settings");
                        setButtonSettings();
                    }

                    console.log("pi has settings: " + JSON.stringify(settings));

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
                    console.log("pi title changed")
                    break

                default:
                    console.log("unhandled event: " + event)
                    break
            }
        } catch (error) {
            console.trace('Could not parse incoming message', error, evt.data);
        }
    };

    console.log("pi message action:" + action);
}


// -----------------------------------------------------------------------------------------------------------------------

function update() {
    console.log("called update()");
    updateProjects()
        .then(ok => {
            console.log(`result of project update: ${ok}`);
            if (ok) {
                let pid = settings["projectId"];
                if (pid !== undefined) {
                    console.log(`setting project ${pid}`);
                    getProjectsHandle().value = pid;

                    updateTasks()
                        .then(ok2 => {
                            if (ok2) {
                                let tid = settings["taskId"];
                                if (tid !== undefined) {
                                    console.log(`setting task ${tid}`);
                                    getTaskHandle().value = tid;
                                    setTask();
                                } else {
                                    console.log("no task in settings");
                                }
                            } else {
                                console.log("task update not ok");
                            }
                        })
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
async function updateProjects() {
    console.log("called updateProjects()");
    let accountId = settings['accountId'];
    let accessToken = settings['accessToken'];

    if (!accountId || !accessToken) {
        console.log("missing id or token");
        setValidAccessToken(false);
        return false;
    }

    console.log("have both an id and access token; will try to get projects");

    return getProjects(accountId, accessToken)
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
            return updateProjectsNow(json);
        })
        .catch(error => {
            console.log(`failed to fetch projects: ${error}`);
            setValidAccessToken(false);
            throw error;
        });
}

function getProjects(accountId, accessToken) {
    console.log("called getProjects()");
    // remove existing projects as soon as we try to get new ones
    clearProjects();
    clearTasks();

    let headers = getHeaders(accountId, accessToken)

    let url = `${apiUrl}/projects?is_active=true&per_page=100`;
    return fetch(url, {method: 'GET', headers: headers});  // return a Promise
}

function getProjectsHandle() {
    return document.getElementById('projectId');
}

function clearProjects() {
    console.log("called clearProjects()");
    let projectSelect = getProjectsHandle();
    while (projectSelect.options.length) projectSelect.remove(0);
    return projectSelect;
}

function updateProjectsNow(data) {
    console.log("called updateProjectsNow()");
    if (data == null) {
        setValidAccessToken(false);
        console.log("null data in updateProjectsNow");
        return false
    } else if (data === {}) {
        setValidAccessToken(false);
        console.log("no useful data in updateProjectsNow: " + JSON.stringify(data));
        return false
    } else if (data["projects"] === undefined) {
        setValidAccessToken(false);
        console.log("no 'projects' data in updateProjectsNow: " + JSON.stringify(data));
        return false
    } else {
        console.log("processing projects");

        let projectSelect = clearProjects();
        if (settings["projectId"] === undefined) {
            // if no current project selected, then put a blank entry first, so user has to select and trigger setProject()
            console.log("adding <select> to project list");
            projectSelect.add(new Option("<select>", 0));
        }
        data["projects"].forEach(project => {
            projectSelect.add(new Option(project['name'], project["id"]));
        });

        setValidAccessToken(true);

        console.log("done with updateProjectsNow");
        return true
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

async function updateTasks() {
    console.log("called updateTasks()");
    return getTasks()
        .then(data => updateTasksNow(data));
}

async function getTasks() {
    console.log("called getTasks()");
    let accountId = settings['accountId'];
    let accessToken = settings['accessToken'];
    let projectId = settings['projectId'];

    clearTasks();
    console.log("we cleared task, so showing warning");
    setValidTask(false);

    if (accountId && accessToken && projectId) {
        let headers = getHeaders(accountId, accessToken)

        let url = `${apiUrl}/projects/${projectId}/task_assignments?is_active=true&per_page=100`;
        console.log(url);

        try {
            let response = await fetch(url, {method: 'GET', headers: headers})
            console.log("done with getTasks");
            return response.json();
        } catch (error) {
            console.log("failed to getTasks: " + error);
            return {};
        }
    } else {
        console.log("skipped getTasks since no project selected");
        return {}
    }
}

function getTaskHandle() {
    return document.getElementById('taskId');
}

function clearTasks() {
    console.log("called clearTasks()");
    let taskSelect = getTaskHandle();
    while (taskSelect.options.length) taskSelect.remove(0);
    return taskSelect;
}

function updateTasksNow(data) {
    console.log("called updateTasksNow()");

    let taskSelect = clearTasks();

    if (settings["taskId"] === undefined) {
        console.log("adding <select> to task list");
        taskSelect.add(new Option("<select>", 0));
    }

    if (data && data !== {} && data["task_assignments"] !== undefined) {
        data["task_assignments"].forEach(project => {
            taskSelect.add(new Option(project['task']['name'], project['task']['id']));
        });

        console.log("done with updateTasks");
        return true
    } else {
        return false
    }
}

function setValidTask(isValid) {
    if (isValid) {
        console.log("hiding warning");
        Array.from(document.getElementsByClassName("validTask")).forEach(elem => elem.classList.add("hidden"));
    } else {
        console.log("showing warning");
        Array.from(document.getElementsByClassName("validTask")).forEach(elem => elem.classList.remove("hidden"));
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
    update()
}

function setProject() {
    let projectId = getProjectsHandle().value;
    console.log(`set project ID to ${projectId}`);
    settings["projectId"] = projectId;
    update()
}

function setTask() {
    let projectId = getProjectsHandle().value;
    let taskId = getTaskHandle().value;

    console.log(`set task ID to ${taskId}`);
    settings["taskId"] = taskId;
    setButtonSettings(uuid);

    if (projectId && taskId) {
        console.log(`valid task and project were found: ${projectId} ${taskId}`);
        setValidTask(true);

        let tasks = getTaskHandle()
        if (tasks[0].value === 0) {
            tasks.remove(0);  // remove the <select> entry now that a selection was made
        } else {
            console.log("nothing to remove task");
        }

    } else {
        console.log("valid task and project not selected");
        setValidTask(false);
    }
}

// -----------------------------------------------------------------------------------------------------------------------

function requestGlobalSettings(forUUID) {
    // Request the global settings of the plugin. Will receive a 'didReceiveGlobalSettings' event/message.
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({
        event: 'getGlobalSettings',
        context: forUUID
    }))
    console.log("pi requested global settings");
}

function setGlobalSettings(forUUID) {
    // Setting these will trigger a 'didReceiveGlobalSettings' event/message IN THE PLUGIN with a copy of the settings.
    if (websocket && websocket.readyState) {
        let payload = {
            accountId: globalSettings['accountId'],
            accessToken: globalSettings['accessToken']
        }
        websocket.send(JSON.stringify({event: 'setGlobalSettings', context: forUUID, payload: payload}))
        console.log("pi set global settings: " + JSON.stringify(payload));
    }
}

function requestButtonSettings(forUUID) {
    // Request the global settings of the plugin. Will receive a 'didReceiveGlobalSettings' event/message.
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({event: 'getSettings', context: forUUID}))
    console.log("pi requested settings");
}

function setButtonSettings(forUUID) {
    // Setting these will trigger a 'didReceiveSettings' event/message IN THE PLUGIN with a copy of the settings.
    if (websocket && websocket.readyState) {
        let payload = {
            type: "timer",
            accountId: settings['accountId'],
            accessToken: settings['accessToken'],
            label: settings['label'],
            projectId: settings['projectId'],
            taskId: settings['taskId'],
            timerType: settings['totalType'],
        }
        websocket.send(JSON.stringify({event: 'setSettings', context: forUUID, payload: payload}))
        console.log("pi set settings: " + JSON.stringify(payload));
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
