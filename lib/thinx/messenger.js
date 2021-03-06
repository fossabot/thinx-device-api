/** This THiNX-RTM API module is responsible for managing MQTT communication. */

var Messenger = (function(){

	//
	// • Should be able to send a message to device using MQTT, internally provide path and authentication.
	// • Should use own MQTT password.
	// • ACLs/role needs to be adjusted for messenger to work globally.
	// • There should be therefore one Messenger instance per owner.
	// • Messenger will fetch device list based on the owner.
	// • Will provide topic-based (should support regex) subscription callback.
	//

	var Rollbar = require("rollbar");
	var app_config = require("../../conf/config.json");
	if (typeof(process.env.CIRCLE_USERNAME) !== "undefined") {
		console.log("» Configuring for Circle CI...");
		app_config = require("../../conf/config-test.json");
	}
	var rollbar = new Rollbar({
		accessToken: app_config.rollbar_token,
		handleUncaughtExceptions: true,
		handleUnhandledRejections: true
	});

	var db = app_config.database_uri;
	var broker = app_config.mqtt_server;

	var fs = require("fs");
	var dateFormat = require("dateformat");
	var mqtt = require("mqtt");

	var prefix = "";
	try {
		var pfx_path = app_config.project_root + '/conf/.thx_prefix';
		if (fs.existsSync(pfx_path)) {
			prefix = fs.readFileSync(pfx_path) + "_";
		}
	} catch (e) {
		//console.log(e);
	}

	var devicelib = require("nano")(db).use(prefix + "managed_devices");
	var userlib = require("nano")(db).use(prefix + "managed_users");

	var client_user_agent = app_config.client_user_agent;
	var slack_webhook = app_config.slack_webhook;
	var mqtt_password = app_config.mqtt_password;
	var mqtt_username = app_config.mqtt_username;
	var mqtt_port = app_config.mqtt_port;

	var base64 = require("base-64");
	var base128 = require("base128");

	var socket;

	var clients = {};
	var master;

	var apikey = require("./apikey");
	var redis = require("redis");
	var device = require("./device");
	var client = redis.createClient(); // TODO: Create secondary Redis client cluster for easier scaling

	var dataclient = redis.createClient(app_config.mqtt_redis_port, app_config.mqtt_redis_url);

	const { RTMClient, WebClient } = require('@slack/client');

	var RTM_EVENTS = require('@slack/client').RTM_EVENTS;
	var CLIENT_EVENTS = require('@slack/client').CLIENT_EVENTS;

	var bot_token;

	if ((typeof(process.env.SLACK_BOT_TOKEN) === "undefined") || (process.env.SLACK_BOT_TOKEN !==
			null)) {
		bot_token = app_config.slack_bot_token;
	} else {
		bot_token = process.env.SLACK_BOT_TOKEN;
	}

	var web;
	var rtm;

	var channel;

	// console.log("» Fetching Redis token...");

	// Fetch Slack bot token from runtime environment (e.g. from recent run)
	client.get("__SLACK_BOT_TOKEN__", function(err, token) {

		if (!err && (typeof(token) !== "undefined") && token !== null) {
			bot_token = token;
		}

		// console.log('» Starting with Redis bot token: ' + bot_token);
		rtm = new RTMClient(bot_token, {
			useRtmConnect: true,
			debug: true,
			dataStore: false
		});

		web = new WebClient(bot_token);

/*
		web.team.info()
			  .then((response) => {
			    // Success!
			    //console.log('Team info response:');
			    //console.log(response);
					channel = response.team.id;
			  })
			  .catch((error) => {
			    // Error :/
			    console.log('Team info error:');
			    console.log(error);
			  });
				*/

		rtm.on('ready', (rtmStartData) => {

			web.conversations.list()
					.then((response) => {
						for (var c in response.channels) {
							const conversation = response.channels[c];
							if (conversation.name == "thinx") {
								//console.log(JSON.stringify(conversation));
								channel = conversation.id;
								var message = 'Kato is ready to serve!';
								web.chat.postMessage({ channel: conversation.id, text: message })
								  .then((res) => {
								    // `res` contains information about the posted message
								    // console.log('Slack Message sent: ', res.ts);
								  })
								  .catch(console.error);
							}
						}
					})
					.catch((error) => {
						// Error :/
						console.log('Conversations list error:');
						console.log(error);
					});

		});

		rtm.on('message', (data) => {
			console.log(`Message from ${data.user}: ${data.text}`);
			if (typeof(_private._socket) !== "undefined" && _private._socket !== null) {
				try {
					_private._socket.send(JSON.stringify(data.text));
				} catch (e) {}
			} else {
				console.log("[messenger] CLIENT_EVENTS forwarder has no websocket");
				if (typeof(err_callback) !== "undefined") {
					err_callback("[messenger] no socket");
				}
			}
		});

		rtm.on('reaction_added', (reaction) => {
			console.log('» Slack API: Reaction added:', reaction);
		});

		rtm.on('reaction_removed', (reaction) => {
			console.log('» Slack API: Reaction removed:', reaction);
		});

		//rtm.connect(bot_token);
		rtm.start();

	});

	// useless so far

	var _private = {
		_owner: null,
		_devices: null,
		_socket: null
	};

	// public
	var _public = {

		init: function() {

			/*
			_public.getAllDevices(function(success, devices) {
				if (success) {
					for (var din in devices) {
						var oid = devices[din][0];
						var udid = devices[din][1];
					}
				}
			});
			*/

			master = mqtt.connect([{
				host: broker,
				port: mqtt_port,
				username: mqtt_username,
				password: mqtt_password
			}]);

			clients = {
				master: master
			};

			master.on("connect", function(error) {
				console.log("[OID:MASTER] MQTT listener connected.");
				master.subscribe("#");
			});

			master.on("reconnect", function() {
				console.log("[OID:MASTER] listener reconnected");
			});

			master.on("error", function(error) {
				console.log("[OID:MASTER] MQTT: error " + error);
			});

			master.on("message", function(topic, message) {

				const msg_string = message.toString();
				if (msg_string.length === 0) return;

				const enc_message = base64.encode(message); // prevent attacks on Redis
				const iso_date = dateFormat(new Date(), "isoDate");

				dataclient.get(topic + "@" + iso_date, function(err, json_keys) {

					var keys = json_keys;

					try {
						keys = JSON.parse(json_keys);
					} catch(e) {
						console.log("error parsing redis keys for dataclient.get: "+e);
					}

					if ((keys === null) || (typeof(keys) === "undefined")) {
						keys = {};
					}

					const now = new Date().getTime();
					// console.log("Incoming MQTT message at: " + now);
					var newkeys = {};
					for (const key in keys) {
						let timestamp = parseInt(key);
						if (timestamp > (now - 86400000)) {
							newkeys[key] = keys[key];
						} else {
							/* DATA LEAD, ONLY FOR DEBUGGING */
							try {
								var keydate = new Date(timestamp);
								console.log("Stripped key: " + keydate + " : " + base64.decode(keys[key]));
							} catch (e) {
								console.log("Stripped invalid key: " + e);
							}
						}
					}

					newkeys[now.toString()] = enc_message;

					dataclient.set(topic + "@" +
						iso_date, JSON.stringify(newkeys),
						function(err) {
							if (err) {
								console.log("MQTT/Redis Action Save Error: " + err);
							}
						});
				});

				// Keeps MQTT Data for 24 hours only
				dataclient.expire(topic, 3 * 86400);

			});

		},

		data: function(owner, udid, callback) {

			console.log("Getting data for owner: " + owner);

			dataclient.keys("/*" + owner + "/" + udid + "*", function(err, replies) {

				//console.log(replies.length + " replies:");

				var results = {};

				var get_result_or_callback = function(reply, i, callback, results, replies) {

					dataclient.get(reply, function(err, json_keys) {

						//console.log("Parsing json_keys: " + json_keys);

						var keys = {};

						try {
							keys = JSON.parse(json_keys);
						} catch (e) {
							console.log(e);
						}

						if (!err) {

							if ((typeof(keys) !== "undefined") || keys !== null) {
								var ks = Object.keys(keys);

								const now = new Date().getTime();
								const keycount = ks.length;

								console.log("Decoding " + keycount + " Keys: ");

								for (var index in ks) {
									const key = ks[index];
									const decoded = base64.decode(keys[key]);
									results[key] = decoded;
									// This is a side-effect, what is the reason for that? Should deprecate or move.
									try {
										results[key] = JSON.parse(decoded);
									} catch (e) {
										// does not matter, just trying...
									}
								}
								console.log("Results: " + JSON.stringify(results));
								if (i == replies.length - 1) {
									callback(true, results);
									console.log("Returning results: " + JSON.stringify(results));
								}

							} else {
								if (i == replies.length - 1) {
									callback(false, "[]");
								}
							}

						}
					});
				};

				replies.forEach(function(reply, i) {
					console.log("    " + i + ": " + reply);
					get_result_or_callback(reply, i, callback, results, replies);
				});

			});


		},

		initWithOwner: function(owner, websocket, callback) {

			// Fetch all devices for owner
			if ((typeof(websocket) === "undefined") || websocket === null) {
				console.log("[messenger] init without socket for owner " + owner);
				return;
			}

			socket = websocket;

			_private._socket = websocket;
			_private._owner = owner; // useless

			rtm.on('message', (data) => {
				var message = data.text;
				console.log(`Message from ${data.user}: ${data.text}`);
				if (typeof(_private._socket) !== "undefined" && _private._socket !== null) {
					try {
						_private._socket.send(JSON.stringify(data.text));
					} catch (e) {}
				} else {
					console.log("[messenger] CLIENT_EVENTS forwarder has no websocket");
					if (typeof(err_callback) !== "undefined") {
						err_callback("[messenger] no socket");
					}
				}
			});

			_public.getDevices(owner, function(success, devices) {

				if (success) {

					_private._devices = devices; // use to fetch aliases by device id!

					// Fetch MQTT authentication for owner
					_public.apiKeyForOwner(owner, function(success, apikey) {

						if (!success) {
							console.log("MQTT: API key fetch failed.");
						}

						if ((typeof(clients[owner]) !== "undefined") && (clients[owner] !== null)) {
							console.log("MQTT/WS client already exists for this owner.");
							// return; happens when Slack gets connected
						}

						// Connect and set callbacks (should use QoS 2 but that's not supported to all clients)
						clients[owner] = mqtt.connect([{
							host: broker,
							port: 1883,
							qos: 1,
							username: owner,
							password: apikey
						}]);

						clients[owner].on("connect", function(error) {

							console.log("[OID:" + owner + "] messenger.initWithOwner() MQTT connected");

							clients[owner].subscribe("/" + owner + "/#");

							var mbody = {
								owner: owner,
								message: "Messenger connected."
							};

							clients[owner].publish(
								"/thinx/announcements",
								JSON.stringify(mbody)
							);

							if (typeof(callback) == "function") {
								if (error.returnCode !== 0) {
									console.log("Messeger using callback with result FALSE.");
									if (typeof(callback) !== "undefined") {
										callback(false, error);
									}
									return;
								} else {
									if (typeof(callback) !== "undefined") {
										callback(true, error);
									}
									return;
								}
							} else {
								console.log("No callback in messenger.js:134");
							}
						});

						clients[owner].on("reconnect", function() {
							console.log("[messenger] reconnected");
						});

						clients[owner].on("error", function(error) {
							console.log("MQTT: error " + error);
							if (typeof(callback) == "function") {
								if (typeof(callback) !== "undefined") {
									callback(false, error);
								}
								return;
							} else {
								console.log("No callback in messenger.js:146");
							}
						});

						clients[owner].on('close', function () {
				        console.log('[slack] Connection closed, retrying...');
				        clients[owner].reconnect();
				    });

						clients[owner].on("message", function(topic, message) {
							if (message.toString().length === 0) return;
							try {
								message = JSON.parse(message.toString());
							} catch (e) {
								try {
									message = JSON.parse(message);
								} catch (e) {
									// if not JSON it's just a message
								}
							}

							// console.log("MQTT Message Object Stringified: " + JSON.stringify( message));

							// more information about additional params https://api.slack.com/methods/chat.postMessage
							var params = {
								icon_emoji: ':bot:'
							};

							// define channel, where bot exist. You can adjust it there https://my.slack.com/services
							if (typeof(bot) !== "undefined") {
								// prevent internal notification forwards
								if (typeof(message.notification) === "undefined") {
									if (typeof(channel) !== "undefined") {
										rtm.sendMessage(message, channel);
									}
								}
							}

							var origins = topic.split("/");
							var oid = origins[1];
							var did = origins[2];

							if (typeof(socket) === "undefined") {
								console.log("Forwarding websocket undefined.");
								return;
							}

							devicelib.get(did, function(error, body) {
								if (error) {
									console.log(error);
									return;
								}
								if (topic.indexOf("/status") !== -1) {
										const changes = {
											udid: did,
											status: message
										};
										device.edit(oid, changes, function(success, message) {
											console.log("MQTT Device Edit Success: "+success+" status: "+status);
										});
										device.run_transformers(did, owner, false, function(rsuccess, rstatus) {
											if (typeof(rstatus) !== "undefined") {
												if (rsuccess) {
													console.log("MQTT Device Edit OK.");
												} else {
													console.log("MQTT Device Failed:");
												}
												console.log("MQTT Status Transformer Status: "+rstatus);
											}
										});
								}
							});

							// Match by message.status (should be optional)

							if (typeof(message.status) !== "undefined") {

								// console.log("Message is kind of Status.");

								devicelib.get(did, function(error, body) {
									if (error) {
										console.log(error);
										return;
									}

									if (message.status == "connected") {
										var notification_in = {
											notification: {
												title: "Check-in",
												body: "Device " + body.alias + " checked-in.",
												type: "info",
												udid: did
											}
										};
										if (socket.readyState === socket.OPEN) {
											socket.send(JSON.stringify(notification_in));
										}
									} else if (message.status == "disconnected") {
										var notification_out = {
											notification: {
												title: "Check-out",
												body: "Device " + body.alias + " disconnected.",
												type: "warning",
												udid: did
											}
										};
										if (socket.readyState === socket.OPEN) {
											socket.send(JSON.stringify(notification_out));
										}
									}
								});

								// Match by message.connected (should be optional)

							} else if (typeof(message.connected) !== "undefined") {

								// console.log("Message is kind of Connected.");

								var status = message.connected ? "Connected" :
									"Disconnected";

								if (message.connected === true) {
									var notification_cc = {
										notification: {
											title: "Device Connected",
											body: oid,
											type: "info",
											udid: did
										}
									};
									if (socket.readyState === socket.OPEN) {
										socket.send(JSON.stringify(notification_cc));
									}
								} else {
									var notification_dc = {
										notification: {
											title: "Device Disconnected",
											body: oid,
											type: "warning",
											udid: did
										}
									};
									if (socket.readyState === socket.OPEN) {
										socket.send(JSON.stringify(notification_dc));
									}
								}

								// Match by Actionability

							} else
							if (typeof(message.notification) !== "undefined") {

								//console.log("Message is kind of Notification.");

								var notification = message.notification;

								// In case the message has "response", it is for device
								// otherwise it is from device.

								var messageFromDevice = (typeof(notification.response) ===
									"undefined") ? true : false;

								if (messageFromDevice) {

									var actionable = {
										notification: {
											nid: did,
											title: "Device Interaction",
											body: notification.body,
											response_type: notification.response_type,
											type: "actionable",
											udid: did
										}
									};

									// Actionable notifications
									var nid = "nid:" + did;

									client.get(nid, function(err, json_keys) {

										if (!err) {
											// nid should have not existed.
											console.log("Actionable notification " + nid +
												" already exists, will not be displayed anymore.");
											if ((typeof(actionable.done) !== "undefined") ||
												(actionable.done === false)) {
												return;
											} else {
												// actionable notification of this type is deleted,
												// when device firmware gets updated;
												// one device can currently manage only one NID notification (thus update replaces old one with same ID)
											}
											return;
										}

										// Send actionable notification to the web...
										if (socket.readyState === socket.OPEN) {
											socket.send(JSON.stringify(actionable));
										} else {
											console.log("Socket not ready.");
										}

										// Attach reply-to topic and store to Redis
										actionable.topic = topic; // reply-to
										actionable.done = false; // user did not respond yet
										var not = JSON.stringify(actionable);
										console.log("Saving actionable: " + not);
										client.set("nid:" + did, not,
											function(err) {
												if (err) {
													console.log("MQTT Action Save Error: " + err);
												}
											});
									});

								} else {

									var notification_to = message.notification;

									// Message for device

									console.log("NID message for device :" + notification_to.nid +
										" : " +
										JSON.stringify(message));

									// Search existing transaction
									client.get("nid:" + notification_to.nid, function(err,
										json_keys) {
										var nid_data = JSON.parse(json_keys);
										if (!err) {
											// NID transaction already exists, update data...
											nid_data.done = true;
											nid_data.response = notification_to.response;
											nid_data.response_type = notification_to.response_type;
										} // if err this is new transaction
										client.set("nid:" + did, JSON.stringify(nid_data),
											function(err) {
												if (err) {
													console.log("MQTT Action Save Error: " + err);
												}
											});
									});
								}

								// Debug unknown notifications (will deprecate)

							} else {

								try {
									var m = JSON.parse(message);
									message = m;
								} catch (e) {
									// message is not json
								}

								var notification_unknown = {
									notification: {
										title: "[DEBUG] Generic Message",
										body: message.toString(),
										type: "success"
									}
								};
								if (socket.readyState === socket.OPEN) {
									socket.send(JSON.stringify(notification_unknown));
								}
							}

						});
					});

					if (typeof(callback) == "function") {
						if (typeof(callback) !== "undefined") {
							callback(true, "messenger_init_success");
						}
						return;
					}
				} else {
					console.log(
						"Error initializing messenger when getting devices for owner " +
						owner);
				}
			});
		},

		getDevices: function(owner, callback) {
			devicelib.view("devicelib", "devices_by_owner", {
					"key": owner,
					"include_docs": false
				},
				function(err, body) {

					if (err) {
						if (err.toString() == "Error: missing") {
							if (typeof(callback) == "function") {
								if (typeof(callback) !== "undefined") {
									callback(false, "no_such_owner_device");
								}
							}
						}
						console.log("/api/user/devices: Error: " + err.toString());
						return;
					}

					var rows = body.rows; // devices returned
					var devices = [];
					for (var row in rows) {
						var rowData = rows[row];
						var device = rowData.value;
						//console.log("Device: " + JSON.stringify(device));
						var topic = "/" + owner + "/" + device.udid;
						devices.push(topic);
					}
					if (typeof(callback) == "function") {
						if (typeof(callback) !== "undefined") {
							callback(true, devices);
						}
					}
				});
		},

		// This might be significant performance issue (first if this kind), we'll need to page this and possibly extract to different app on different server!
		getAllOwners: function(callback) {
			userlib.view("users", "owners_by_id", {
					"include_docs": true
				},
				function(err, body) {

					if (err) {
						if (err.toString().indexOf("Error: missing") !== -1) {
							if (typeof(callback) !== "undefined") {
								callback(false, "no_owners");
							}
						}
						console.log("/api/user/devices: Error: " + err.toString());
						return;
					}

					var rows = body.rows; // devices returned
					var devices = [];
					for (var row in rows) {
						var rowData = rows[row];
						var device = rowData.value;
						devices.push([device.owner, device.udid]);
					}
					if (typeof(callback) !== "undefined") {
						callback(true, devices);
					}
				});
		},

		// Fetch API key from Redis, should be the MQTT API key...
		apiKeyForOwner: function(owner, callback) {
			apikey.list(owner, function(success, keys) {
				if (success) {
					if (typeof(callback) !== "undefined") {
						callback(true, keys[0]); // using first API key by default until we'll have initial API key based on user creation.
					}
				} else {
					if (typeof(callback) !== "undefined") {
						callback(success, keys);
					}
				}
			});
		},

		// Receive a WS chat message and slack it...
		slack: function(owner, message, callback) {
			// define channel, where bot exist. You can adjust it there https://my.slack.com/services

			if ((typeof(channel) === "undefined") || (channel === null)) {

				client.get("__SLACK_CHANNEL_ID__", function(err, ch) {

					if (!err && (typeof(ch) !== "undefined") && ch !== null) {
						channel = ch;

						console.log("using Channel: "+ch);

						rtm.sendMessage(message, channel, function(err, response) {
							if (err) {
								console.log(err);
							}
							if (typeof(callback) !== "undefined") {
								if (err) {
									callback(err, response);
								} else {
									callback(false, "message_sent");
								}
							}
						});
					} else {
						console.log("Cannot Slack '" + "', no channel given.");
						return;
					}

				});

			} else {

				rtm.sendMessage(message, channel, function(err, response) {
					if (err) {
						console.log(err);
					}
					if (typeof(callback) !== "undefined") {
						if (err) {
							callback(err, response);
						} else {
							callback(false, "message_sent");
						}
					}
				});
			}


		},

		// Respond to a slack? WTF? How? We need a SLACKBOT!

		// Send a message to device
		publish: function(owner, udid, message) {

			if (typeof(client[owner]) === "undefined") {
				console.log("Creating new MQTT client for owner: " + owner);
				clients[owner] = mqtt.connect([{
					host: broker,
					port: 1883,
					qos: 1,
					username: owner,
					password: _public.apiKeyForOwner(owner)
				}]);

			} else {

				var mqtt_topic = "/" + owner + "/" + udid;

				// Check for actionable notifications and pick up transaction from Redis
				if (typeof(message.nid) !== "undefined") {
					var nid = "nid:" + message.nid;
					var reply = message.reply;
					message.topic = mqtt_topic;
					message.done = true; // user already responded; never notify again...
					client.set(nid, JSON.stringify(message), function(err) {
						if (err) {
							console.log(err);
						}
					});

					// In case the notification contains 'nid'; send only 'reply' and delete this nid from redis.
					client[owner].publish(mqtt_topic, message);
				}
			}
		}
	};

	return _public;

})();

exports.init = Messenger.init;
exports.data = Messenger.data;

exports.initWithOwner = Messenger.initWithOwner;
exports.getDevices = Messenger.getDevices;
exports.getAllOwners = Messenger.getAllOwners;
exports.apiKeyForOwner = Messenger.apiKeyForOwner;
exports.publish = Messenger.publish;
exports.slack = Messenger.slack;
