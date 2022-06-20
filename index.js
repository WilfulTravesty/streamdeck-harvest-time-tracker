const harvestBaseUrl = 'https://api.harvestapp.com/v2'

let websocket = null;
let currentButtons = new Map();
let polling = false;
let globalSettings = {};
let cache = {};  // cache of last gets, for fast redraw when switching pages

const secondsBetweenUpdates = 10;
let nextUpdateTimeUnix = Date.now();

const debug = {
    // plugin actions like registering, config, or creating/deleting buttons
    plugin: false,
    // html calls and responses
    html: false,
    // button state manipulation
    tasks: false,
    // task button labels
    labels: false,
    // button label calculations and decisions
    calculations: false,
    // init loop
    init: false
}

// noinspection JSUnusedLocalSymbols
function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, _inInfo) {
    websocket = new WebSocket('ws://127.0.0.1:' + inPort);

    websocket.onopen = function () {
        const json = {
            "event": inRegisterEvent, "uuid": inPluginUUID
        };

        websocket.send(JSON.stringify(json));

        if (debug.plugin) console.log("registered plugin");
        refreshButtons();
    }

    websocket.onmessage = function (evt) {
        // Received message from Stream Deck
        const jsonObj = JSON.parse(evt.data);
        const {event, context, payload, action} = jsonObj;

        if (debug.plugin) console.log("incoming action " + event + " for " + action);

        switch (event) {
            case 'keyDown': {
                const settings = payload["settings"]
                if (debug.plugin) console.log("pressed " + settings["label"]);
                toggleButtonState(context, settings).then();
            }
                break

            case 'willAppear': {
                const settings = payload["settings"]
                const coordinates = payload["coordinates"]
                if (!payload["isInMultiAction"]) {
                    addButton(context, settings, coordinates);
                    if (debug.plugin) console.log("button added to row " + (coordinates["row"] + 1) + " column " + (coordinates["column"] + 1));
                }
            }
                break

            case 'willDisappear': {
                const coordinates = payload["coordinates"]
                if (debug.plugin) console.log("button removed from row " + (coordinates["row"] + 1) + " column " + (coordinates["column"] + 1));
                if (!payload["isInMultiAction"]) removeButton(context);
            }
                break

            case 'didReceiveSettings': {
                // anything could have changed, pull it, add it, and refresh.
                const settings = payload["settings"]
                const coordinates = payload["coordinates"]
                if (debug.plugin) console.log(">>> received settings for button " + context + " labeled " + JSON.stringify(settings["label"]));
                if (!payload["isInMultiAction"]) {
                    removeButton(context);
                    addButton(context, settings, coordinates);
                    refreshButtons();
                    if (debug.plugin) console.log("plugin received settings: " + JSON.stringify(payload["settings"]));
                }
            }
                break

            case 'propertyInspectorDidDisappear':
                // When a button's PI closes, ask for the last saved settings
                requestButtonSettings(context);
                break;

            case 'didReceiveGlobalSettings':
                globalSettings = jsonObj['payload']['settings'];
                if (debug.plugin) console.log("plugin received global settings: " + JSON.stringify(globalSettings));
                break

            case 'titleParametersDidChange':
                if (debug.plugin) console.log("plugin title changed")
                break
        }
    }
}

/** Delay helper function. */
function delay(timeMs) {
    return new Promise(resolve => setTimeout(resolve, timeMs));
}

/** Wait, then update buttons. */
function waitThenUpdateButtons() {
    // if regular update is within 2 seconds, just let it handle the update
    if ((nextUpdateTimeUnix - Date.now()) < 2000) return;

    nextUpdateTimeUnix = Date.now() + (5 * 1000);  // at least defer auto-update until we're done
    if (debug.init) console.log(`*** next update defer time ${nextUpdateTimeUnix}`);
    delay(1000)  // allow time for Harvest to update server
        .then(() => {
            refreshButtons();
            nextUpdateTimeUnix = Date.now() + (secondsBetweenUpdates * 1000); // set real "next" auto-update time
            if (debug.init) console.log(`*** next update time ${nextUpdateTimeUnix}`);
        })
}

/**
 * Attempt to toggle the state of a task button. Will return without action for a "totals" button.
 * If the button task is active, then stop it, otherwise start it.
 *
 * @param {string} context
 * @param {object} settings
 *
 * @returns {Promise<number|*>}
 */
async function toggleButtonState(context, settings) {
    let accountId = settings['accountId'];
    let accessToken = settings['accessToken'];

    if (settings["type"] !== "timer") return Promise.resolve(0);

    return getCurrentActiveHarvestTimeEntry(accountId, accessToken, "is_running=true")
        .then(entryData => {
            if (entryData["time_entries"].length === 0) {
                // Nothing is running, so start one
                if (debug.tasks) console.log("no task is currently running, so start a new one");
                startHarvestTask(context, settings).then(() => { waitThenUpdateButtons() });
            } else if (entryData["time_entries"][0]["project"]["id"].toString() === settings["projectId"] &&
                entryData["time_entries"][0]["task"]["id"].toString() === settings["taskId"]) {
                // The one running is "this one", stop it
                if (debug.tasks) console.log("have data matching an active button, so stop it");
                stopHarvestTask(context, settings, entryData["time_entries"][0]["id"]).then(() => { waitThenUpdateButtons() });
            } else {
                // Some other one is running. Just start the new one, old one will stop.
                if (debug.tasks) console.log("running task does not match this button task, so start a new one");
                startHarvestTask(context, settings).then(() => { waitThenUpdateButtons() });
            }
        })
        .catch(error => {
            // set all "total" buttons on this account to an error
            console.log(`failed to fetch current time entry: ${error}`);
            currentButtons.forEach((buttonSettings, buttonContext) => {
                if (buttonSettings === undefined || buttonSettings["type"] !== "timer") return;
                if (accountId === buttonSettings['accountId']) {
                    updateButton(buttonContext, {
                        hours: 0,
                        label: buttonSettings["label"],
                        state: 0,
                        showTime: false
                    });
                    showAlert(buttonContext, `task time fetch 2 failed with error ${error}`);
                }
            });
            nextUpdateTimeUnix = Date.now() + secondsBetweenUpdates;
            if (debug.init) console.log(`*** next update time ${nextUpdateTimeUnix}`);
        })
}

// ----------------------------------------------------------------------------------------------------------------
// HTML generic request handler
// ----------------------------------------------------------------------------------------------------------------
/**
 * Generic function to fetch HTML data. Returns a Promise that throws an Error exception if response status
 * case is not 200, else returns the Response object's JSON.
 *
 * @param method GET, POST, PUT, DELETE, etc
 * @param url the URL to process
 * @param headers the headers to include in the request
 * @param [body] optional body for POST, PUT requests
 * @param [expectedStatus] optional response status expected if not 200 (e.g. 201 for Created)
 */
function htmlRequest(method, url, headers, body, expectedStatus = 200) {
    let req;
    if (method === 'GET') {
        req = fetch(url, {method: method, headers: headers})
    } else {
        req = fetch(url, {method: method, headers: headers, body: body})
    }

    return req.then(response => {
        if (response.status !== expectedStatus) {
            console.log(response.text());
            throw new Error(`bad rc=${response.status}: ${response.text()}`);
        } else {
            return response.json();
        }
    });
}

/**
 * Call htmlRequest, but on error update button label with static message
 */
function htmlRequestOrButtonError(context, label, method, url, headers, body) {
    return htmlRequest(method, url, headers, body)
        .catch(error => {
            console.log(`failed to start time entry: ${error}`);
            updateButton(context, {
                hours: 99999,
                label: label,
                state: 0,
                showTime: false
            });
            throw error;
        });
}

// ------------------------------------------------------------------------------------------------------------------
// StreamDeck button event handlers
// ------------------------------------------------------------------------------------------------------------------
/**
 * Request the stored StreamDeck settings for a button.
 *
 * @param {string} uuid
 */
function requestButtonSettings(uuid) {
    // Request the global settings of the plugin. Will receive a 'didReceiveGlobalSettings' event/message.
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({event: 'getSettings', context: uuid}));
    if (debug.plugin) console.log("plugin requested settings for " + uuid);
}

/**
 * A button was removed from the StreamDeck.
 *
 * @param {string} context
 */
function removeButton(context) {
    if (currentButtons.delete(context) && debug.plugin) console.log("removed button " + context);
}

/**
 * A new button was added to the StreamDeck.
 *
 * @param {string} context
 * @param {object} settings
 * @param {object} coordinates
 */
function addButton(context, settings, coordinates) {
    settings["row"] = coordinates["row"];
    settings["column"] = coordinates["column"];
    if (debug.tasks || debug.labels) console.log(`added button ${context} with label '${settings["label"]}' and settings ${JSON.stringify(settings)}`);
    currentButtons.set(context, settings);
    refreshButtonFromCache(settings["row"], settings["column"]);
    initPolling().then();
}

// ------------------------------------------------------------------------------------------------------------------

/**
 * Set up a polling loop to keep button status updated.
 *
 * @returns {Promise<void>}
 */
async function initPolling() {
    if (polling) return;

    polling = true;
    if (debug.plugin || debug.init) console.log("beginning to poll");
    refreshButtons();
    while (currentButtons.size > 0) { // eslint-disable-line no-unmodified-loop-condition
        // The rate limit for general API requests is 100 requests per 15 seconds.
        if (debug.init) console.log(`waiting 10000 ms for next update time ${nextUpdateTimeUnix}`);
        await delay(10000);
        let extraWait = nextUpdateTimeUnix - Date.now();
        if (debug.init) console.log(`after wait time is now ${Date.now()} with ${extraWait} extra wait needed`);
        if (extraWait > 0) {
            if (debug.init) console.log(`waiting ${extraWait} ms more`);
            await delay(extraWait);
        }
        refreshButtons();
        nextUpdateTimeUnix = Date.now() + (secondsBetweenUpdates * 1000);
        if (debug.init) console.log(`next update time ${nextUpdateTimeUnix}`);
    }

    if (debug.plugin || debug.init) console.log("stopping polling, no buttons remain");
    polling = false;
}

// ------------------------------------------------------------------------------------------------------------------
// Button label update functions
// ------------------------------------------------------------------------------------------------------------------

function decToHM(decHours) {
    let hrs = Math.floor(decHours);
    let min = Math.ceil((decHours - hrs) * 60.0);
    return hrs + ":" + min.toString(10).padStart(2, '0');
}

/**
 * Process all entries for this account and sum their times for each project, then update the button calculations.
 * Uses JSON data from global "cache" variable.
 *
 * @param {string} accountId
 * @param {any} totals
 * @param {boolean} isLastAccount boolean
 * @param {number | null} row may be null, else only update button in the specified row and column
 * @param {number | null} column may be null, else only update button in the specified row and column
 */
function setTotalButtonLabels(accountId, {totals, isLastAccount, row, column} = {}) {
    let json = cache[`entriesPayload-${accountId}`];

    let accountActive = false;
    json["time_entries"].forEach(entry => {
        if (entry["is_running"]) accountActive = true;
    })

    json["time_entries"].forEach(entry => {
        let hours = entry["rounded_hours"];
        totals["weeklyHours"] += hours;
        if (debug.calculations) console.log(`adding ${decToHM(hours)} for ${entry["project"]["name"]} ${entry["task"]["name"]} => ${decToHM(totals["weeklyHours"])}`);

        if (debug.calculations) console.log(`${entry["spent_date"]} vs ${totals["today"]}`)
        if (entry["spent_date"] === totals["today"]) {
            totals["dailyHours"] += hours;
            if (debug.calculations) console.log(`adding ${hours} hours for daily => ${totals["dailyHours"]}`);
        }

        let projectKey = entry["project"]["id"];
        if (totals["project"][projectKey] === undefined) totals["project"][projectKey] = 0.0;
        totals["project"][projectKey] += hours;
        if (debug.calculations) console.log(`adding ${hours} hours for ${projectKey}`);

        let clientKey = entry["client"]["id"];
        if (totals["client"][clientKey] === undefined) totals["client"][clientKey] = 0.0;
        totals["client"][clientKey] += hours;
        if (debug.calculations) console.log(`adding ${hours} hours for client ${entry["client"]["name"]}`);
    })

    // Daily total buttons
    currentButtons.forEach((settings, context) => {
        if (settings === undefined) return;  // button not configured yet
        if (settings["type"] === "timer" || settings["type"] === "weekly") return;

        if (row !== undefined && column !== undefined && (row !== settings["row"] || column !== settings["column"])) {
            return; // skip this forEach iteration until we find the button
        }

        if (accountId === settings['accountId']) {
            let key = undefined;
            let value = undefined;
            if (settings["type"] === "project") {
                key = settings["projectId"];
                value = totals["project"][key];
            }
            if (settings["type"] === "client") {
                key = settings["clientId"];
                value = totals["client"][key];
            }
            if (settings["type"] === "daily") {
                key = "daily";
                value = totals["dailyHours"];
            }
            if (debug.calculations) console.log("total hours = " + value + " for " + settings["type"] + " " + key);
            let label = settings["label"];
            if (debug.calculations) console.log(`label1 = "${label}" for ${accountActive} ${context}`);
            updateButton(context, {
                hours: value,
                label: label,
                state: accountActive ? 1 : 0,
                showTime: true,
                sep: "\n"
            });
        }
    })

    // After last account, update "weekly" buttons
    // accountCounter++;
    // if (accounts.size === accountCounter) {
    if (isLastAccount) {
        // Now process weekly total buttons, which include all accounts
        currentButtons.forEach((settings, context) => {
            if (settings === undefined) return;
            if (settings["type"] !== "weekly") return;

            if (debug.calculations) console.log(`total hours = ${totals["weeklyHours"]} for ${settings["type"]}`);
            let label = settings["label"];
            if (debug.calculations) console.log(`label2 = "${label}" for ${accountActive} ${context}`);
            updateButton(context, {
                hours: totals["weeklyHours"],
                label: label,
                state: accountActive ? 1 : 0,
                showTime: true,
                sep: "\n"
            });
        })
    }
}

/**
 * Update the calculations on the task buttons, from the cached data.
 *
 * @param {string} accountId
 * @param {number | undefined} row may be undefined, else only update button in the specified row and column
 * @param {number | undefined} column may be undefined, else only update button in the specified row and column
 */
function setTaskButtonLabels(accountId, row, column) {
    const entries = cache[`runningPayload-${accountId}`]["time_entries"];

    if (entries !== undefined && entries.length > 0) {
        // Should only ever be 1 active entry
        let entryData = entries[0];

        if (debug.html) console.log(`got data: ` + JSON.stringify(entryData))

        //Loop over all the buttons and update as appropriate
        currentButtons.forEach((settings, context) => {
            // Only process configured, individual task timer buttons here
            if (settings !== undefined && settings["type"] === "timer") {
                if (row !== undefined && column !== undefined && (row !== settings["row"] || column !== settings["column"])) {
                    return; // skip this forEach iteration until we find the button
                }

                if (accountId === settings["accountId"] && entryData["project"]["id"].toString() === settings["projectId"] && entryData["task"]["id"].toString() === settings["taskId"]) {
                    if (debug.calculations) console.log("button " + settings.label + " is on")
                    updateButton(context, {
                        hours: entryData["hours"],
                        label: settings["label"],
                        state: 1,
                        showTime: true
                    });
                } else { //if not, make sure it's 'off'
                    if (debug.calculations) console.log("button " + settings.label + " is off")
                    updateButton(context, {
                        hours: 0,
                        label: settings["label"],
                        state: 0,
                        showTime: false
                    });
                }
            }
        })
    } else {
        if (debug.tasks) console.log("no active time entries found on this account");

        //Loop over all the buttons on this account and mark them "off"
        currentButtons.forEach((settings, context) => {
            if (settings !== undefined && settings["type"] === "timer") {
                if (row !== undefined && column !== undefined && (row !== settings["row"] || column !== settings["column"])) {
                    return; // skip this forEach iteration until we find the button
                }

                // Only process configured, individual task timer buttons here
                if (accountId === settings["accountId"]) {
                    if (debug.calculations) console.log("button " + settings.label + " is off")
                    updateButton(context, {
                        hours: 0,
                        label: settings["label"],
                        state: 0,
                        showTime: false
                    })
                }
            }
        })
    }
}

/**
 * Refresh the button in the specified row and column using cached data. Used for page changes.
 *
 * @param {number} row
 * @param {number} column
 */
function refreshButtonFromCache(row, column) {
    if (debug.calculations) console.log(`refreshing button at row ${row} and column ${column} from cache`);

    // Check if no data yet
    if (cache["accountsMap"] === undefined) return;

    if (cache["haveTotals"]) {
        const today = new Date();
        const todayDate = today.getFullYear() + "-" + leadingZero(today.getMonth() + 1) + "-" + leadingZero(today.getDate());
        let totals = {"weeklyHours": 0.0, "dailyHours": 0.0, "project": {}, "client": {}, "today": todayDate}

        // Process each account, then find buttons that use data from that account, while keeping up the weekly total
        let accountCounter = 0;
        cache["accountsMap"].forEach((_accessToken, accountId) => {
            if (debug.calculations) console.log(`processing cached account ${accountId} for totals`);
            if (cache[`entriesPayload-${accountId}`] !== undefined) {
                if (debug.calculations) console.log("calling cached setTotalButtonLabels()");
                accountCounter++;
                setTotalButtonLabels(accountId, {
                    totals: totals,
                    isLastAccount: (cache["accountCount"] === accountCounter),
                    row: row, column: column
                });
            } else {
                currentButtons.forEach((settings, context) => {
                    if (settings === undefined || settings["type"] !== "timer") return;
                    if (row !== settings["row"] || column !== settings["column"]) return;
                    if (accountId === settings['accountId']) {
                        updateButton(context, {
                            hours: 0,
                            label: settings['label'],
                            state: 0,
                            showTime: false
                        });
                    }
                })
            }
        }) // accounts.forEach
    } // if haveTotals

    // Process task timer buttons
    cache["accountsMap"].forEach((_accessToken, accountId) => {
        if (debug.calculations) console.log(`processing cached account ${accountId} for timer`);
        if (cache[`runningPayload-${accountId}`] !== undefined) {
            setTaskButtonLabels(accountId, row, column);
        } else {
            currentButtons.forEach((settings, context) => {
                if (settings === undefined || settings["type"] !== "timer") return;
                if (row !== settings["row"] || column !== settings["column"]) return;
                if (accountId === settings['accountId']) {
                    updateButton(context, {
                        hours: 0,
                        label: settings["label"],
                        state: 1,
                        showTime: true
                    })
                }
            })
        }
    })
}

/**
 * Fetch new data and update all buttons for all Harvest accounts.
 */
function refreshButtons() {
    if (debug.calculations) console.log(`refreshing buttons`);

    // Get the list of unique accounts + access tokens to query
    let accounts = new Map();
    let haveTotals = false;
    // noinspection JSUnusedLocalSymbols
    currentButtons.forEach((settings, _context, _map) => {
        if (settings === undefined) return;

        let accountId = settings["accountId"];
        let accessToken = settings["accessToken"];
        if (accountId && accessToken) {  // ignore incomplete buttons
            accounts.set(accountId, accessToken);
        }

        if (settings["type"] === "weekly") haveTotals = true;
        if (settings["type"] === "daily") haveTotals = true;
        if (settings["type"] === "project") haveTotals = true;
        if (settings["type"] === "client") haveTotals = true;
    })

    if (debug.tasks) console.log("we have " + accounts.size + " accounts to query");
    cache["accountCount"] = accounts.size;
    cache["accountsMap"] = accounts;

    if (haveTotals) {
        cache["haveTotals"] = true;

        const today = new Date();
        const todayDate = today.getFullYear() + "-" + leadingZero(today.getMonth() + 1) + "-" + leadingZero(today.getDate());
        let totals = {
            "weeklyHours": 0.0, "dailyHours": 0.0, "project": {}, "client": {}, "today": todayDate
        }

        const mondayDateObj = new Date();
        mondayDateObj.setDate(mondayDateObj.getDate() - (mondayDateObj.getDay() + 6) % 7);
        const endOfWeek = new Date(mondayDateObj);
        endOfWeek.setDate(endOfWeek.getDate() + 7);
        const from = mondayDateObj.getFullYear() + leadingZero(mondayDateObj.getMonth() + 1) + leadingZero(mondayDateObj.getDate());
        const to = endOfWeek.getFullYear() + leadingZero(endOfWeek.getMonth() + 1) + leadingZero(endOfWeek.getDate());

        // Process each account, then find buttons that use data from that account, while keeping up the weekly total
        let accountCounter = 0;
        accounts.forEach((accessToken, accountId) => {
            if (debug.tasks) console.log(`processing account ${accountId}`);
            const headers = getHeaders(accountId, accessToken);

            const url = `${harvestBaseUrl}/time_entries?from=${from}&to=${to}&per_page=100`;
            if (debug.html) console.log(`totals GET ${url}`);

            htmlRequest('GET', url, headers)
                .then(json => {
                    cache[`entriesPayload-${accountId}`] = json;
                    if (debug.tasks) console.log("calling setTotalButtonLabels()");
                    accountCounter++;
                    setTotalButtonLabels(accountId, {
                        totals: totals,
                        isLastAccount: (accounts.size === accountCounter),
                        row: undefined, column: undefined
                    });
                })
                .catch(error => {
                    console.log(`url fetch failed: ${error}`);
                    cache[`entriesPayload-${accountId}`] = {"time_entries": []};
                    // set all "total" buttons on this account to an error
                    currentButtons.forEach((settings, context) => {
                        if (settings === undefined || settings["type"] !== "timer") return;
                        if (accountId === settings['accountId']) {
                            updateButton(context, {
                                hours: 0,
                                label: "ERROR",
                                state: 0,
                                showTime: false
                            });
                            showAlert(context).then();
                        }
                    })
                })
        }) // accounts.forEach
    } else { // if (haveTotals) ...
        cache["haveTotals"] = false;
    }

    // Process task timer buttons (not totals buttons)
    accounts.forEach((accessToken, accountId) => {
        if (debug.tasks) console.log(`processing account ${accountId} for timers`);

        let args = "is_running=true";
        getCurrentActiveHarvestTimeEntry(accountId, accessToken, args)
            .then(json => {
                cache[`runningPayload-${accountId}`] = json;
                if (debug.html) console.log(`we just cached JSON ${JSON.stringify(json)}`);
                setTaskButtonLabels(accountId, undefined, undefined);
            })
            .catch(error => {
                // set all "total" buttons on this account to an error
                if (debug.html) console.log(`failed to fetch current time entry: ${error}`);
                currentButtons.forEach((settings, context) => {
                    if (settings === undefined || settings["type"] !== "timer") return;
                    if (accountId === settings['accountId']) {
                        updateButton(context, {
                            hours: 0,
                            label: settings["label"],
                            state: 0,
                            showTime: false
                        })
                        showAlert(context, `task time fetch 1 failed with error ${error}`).then();
                    }
                })
            })
    })
}

// ------------------------------------------------------------------------------------------------------------------
// Harvest API Helpers
// ------------------------------------------------------------------------------------------------------------------

/**
 * Get the current time entries and return the JSON for them. Throws error on failure.
 *
 * @param {string} accountId the account ID
 * @param {string} accessToken the user access token for the account
 * @param {string} args arguments to append to URL
 *
 * @returns {Promise<any>}
 */
async function getCurrentActiveHarvestTimeEntry(accountId, accessToken, args) {
    const headers = getHeaders(accountId, accessToken);
    let url = `${harvestBaseUrl}/time_entries?${args}`;
    if (debug.html) console.log(`GET ${url}`);
    return htmlRequest('GET', url, headers);
}

/**
 * Start a Harvest task via the Harvest API. Return JSON, or throw error on failure.
 *
 * @param {string} context button context id
 * @param {object} settings button app settings
 *
 * @returns {Promise<Response>}
 */
async function startHarvestTask(context, settings) {
    let accountId = settings['accountId'];
    let accessToken = settings['accessToken'];
    let headers = getHeaders(accountId, accessToken);
    let projectId = settings['projectId'];
    let taskId = settings['taskId'];

    if (debug.tasks) console.log(`account ${accountId} access ${accessToken} project ${projectId} task ${taskId}`)

    const today = new Date();  // need 2017-03-21
    const todayDate = today.getFullYear() + "-" + leadingZero(today.getMonth() + 1) + "-" + leadingZero(today.getDate());

    // Quickly set it to 0:00 just so it shows "active" until next refresh
    updateButton(context, {
        hours: 0,
        label: settings["label"],
        state: 1,
        showTime: true
    });

    const url = `${harvestBaseUrl}/time_entries`;
    const body = JSON.stringify({project_id: parseInt(projectId), task_id: parseInt(taskId), spent_date: todayDate});
    // POST to this URL returns a SINGLE time entry, not a list!
    htmlRequest('POST', url, headers, body, 201)
        .then(json => {
            if (debug.tasks) console.log(`new time id ${json["id"]}`);
        })
        .catch(error => {
            console.log(`failed to start time entry: ${error}`);
            updateButton(context, {
                hours: 0,
                label: settings["label"],
                state: 0,
                showTime: false
            });
            throw error;
        });
}

/**
 * Stop a running Harvest task via the Harvest API. Return JSON, or throw error.
 *
 * @param {string} context button context id
 * @param {object} settings button app settings
 * @param {string} timeId harvest timer uuid
 *
 * @returns {Promise<Response>}
 */

async function stopHarvestTask(context, settings, timeId) {
    let accountId = settings['accountId'];
    let accessToken = settings['accessToken'];
    let headers = getHeaders(accountId, accessToken)

    // Set the button back to inactive until next refresh
    updateButton(context, {
        hours: 0,
        label: settings["label"],
        state: 0,
        showTime: false
    });

    const url = `${harvestBaseUrl}/time_entries/${timeId}/stop`;
    return htmlRequestOrButtonError(context, settings["label"], 'PATCH', url, headers)
        .then(() => {
            if (debug.tasks) console.log(`stopped timer ${timeId}`);
        })
}

// ----------------------------------------------------------------------------------------------------------------
// Functions to update StreamDeck buttons via web API
// ----------------------------------------------------------------------------------------------------------------

/**
 * Format a float hours as hours and minutes.
 *
 * @param {number} hoursRunning
 *
 * @returns {string}
 */
function formatElapsed(hoursRunning) {
    const hours = Math.floor(hoursRunning);
    const minutes = Math.floor(((hoursRunning - hours) * 60.0));
    return `${hours}:${leadingZero(minutes)}`;
}

/**
 * Add leading zero to a number if less than 10.
 *
 * @param {number} val
 *
 * @returns {string|*}
 */
function leadingZero(val) {
    if (val < 10) return '0' + val;
    return val;
}

/**
 * Update StreamDeck button state and label.
 *
 * @param {string} context button UUID context
 * @param {number} hours float hours to display on button
 * @param {string} label text to display at bottom of button, if not null or empty string
 * @param {number} state which state {0, 1, etc} from manifest, to display button as
 * @param {boolean} showTime true to show time + label, false to show just label
 * @param {string} sep separator between time and label (up to 3 lines supported)
 */
function updateButton(context, {hours, label, state = 0, showTime = false, sep = "\n\n"}) {
    // Set the icon to use from the defined States list in the manifest. We use
    // slot 0 when not active or only 1 icon, and slot 1 when active.
    setState(context, state).then();

    if (label !== undefined) {
        // replaceAll() is not supported, so allow up to 3 lines, which fills the button
        label = label.replace("<NL>", "\n").replace("<NL>", "\n").replace("<NL>", "\n");
    }

    if (showTime === false) {
        setTitle(context, label).then();
    } else {
        if (hours === undefined) hours = 0.0;

        if (label === undefined || label === "") {
            setTitle(context, `${formatElapsed(hours)}`).then();
        } else {
            setTitle(context, `${formatElapsed(hours)}${sep}${label}`).then();
        }
    }
}

/**
 * Set Streamdeck button state.
 *
 * @param {string} context
 * @param {number} state - the state from the manifest state list
 */
async function setState(context, state) {
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({
        event: 'setState', context: context, payload: {
            state: state
        }
    }));
}

/**
 * Set StreamDeck button title.
 *
 * @param {string} context
 * @param {string} title
 */
async function setTitle(context, title) {
    if (debug.labels) console.log(`updating "${currentButtons.get(context)["type"]}" button ${context} with label "${title}"`)
    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({
        event: 'setTitle', context: context, payload: {
            title: title
        }
    }));
}

/**
 * Show an alert on a button.
 *
 * @param {string} context
 * @param {string} reason logged to console
 */
async function showAlert(context, reason = "unknown") {
    if (reason) console.log(`ALERT!!! showing alert for context ${context} because ${reason}`);
    else if (debug.labels) console.log(`ALERT!!! showing alert for context ${context}`);

    websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({
        event: 'showAlert', context: context
    }));
}

/**
 * Generate the account access headers for the V2 Harvest API.
 *
 * @param {string} accountId
 * @param {string} accessToken
 *
 * @returns {Headers}
 */
function getHeaders(accountId, accessToken) {
    return new Headers({
        "User-Agent": "streamdeck ${streamDeckVersion} com.wolfzoo.harvest plugin ${pluginVersion}",
        "Authorization": "Bearer " + accessToken,
        "Harvest-Account-ID": accountId,
        'Content-Type': 'application/json'
    });
}
