#!/usr/bin/env node

var irc = require('./node_modules/irc'),
    cli = require('./node_modules/cli'),
    http = require('http'),
    url = require('url'),
    fs = require('fs');


cli.parse({
    config: ['c', 'Config File', 'string', './connections.json'],
    http: ['p', 'HTTP Port to listen on', 'int', 8888],
    debug: ['d', 'Turn on Debug mode', 'boolean', false],
});


// The main configuration object
var CONFIG = {};

// The currently connected clients
var IRC_CONNECTIONS = {};

// Read the config file (sync) and blindly run an eval() on it to try and
// quickly get the latest CONFIG object. Note this function can be called
// with no parameters or as the handler to a watchFile() call.
function parse_conf_file (curr, prev) {
    if((!curr) || (curr.mtime > prev.mtime)) {
        console.log('Reading config file ');

        try {
            var buff = fs.readFileSync(cli.options.config, 'utf8');
            eval('CONFIG = ' + buff);
        }
        catch(err) {
            console.error("ERROR PARSING CONFIG FILE " + err);
        }

        reconnect_irc();
    }
}


// Go through and disconnect all our IRC clients and reconnect from the 
// latest CONFIG
function reconnect_irc() {
    for(var i in IRC_CONNECTIONS) {
        IRC_CONNECTIONS[i].disconnect('brb');
        IRC_CONNECTIONS[i] = undefined;
    }

    for(var i in CONFIG) {
        var c = CONFIG[i];

        var client = new irc.Client(c.host, c.nick || 'PostBot', { userName: c.nick || 'PostBot', realName: c.name || 'Post Bot', port: c.port || 6697, debug: cli.options.debug, autoRejoin: true, autoConnect: true, secure: c.ssl || false, selfSigned: true, floodProtection: false, stripColors: true, channels: c.channels , });

        IRC_CONNECTIONS[i] = client;
        IRC_CONNECTIONS[i].CONFIG = c;  // stick this config in with the client

        // Try to set our nick and user info
        client.send('USER ' + (c.user || c.nick || 'PostBot') + ' 0 * :' + (c.name || 'Post Bot'));
        client.send('NICK ' + (c.nick || 'PostBot'));

        register_handlers(client);

        // If there are logincmds for this config then send them
        if((c.logincmds) && (c.logincmds.constructor == Array)) {
            for(var j=0; j<c.logincmds.length; j++) {
                client.send(c.logincmds[j]);
            }
        }

        // Try and join all the channels in the config (and send a greeting)
        if((c.channels) && (c.channels.constructor == Array)) {
            for(var j=0; j<c.channels.length; j++) {
                client.join(c.channels[j]);
                if(c.greeting) {
                    client.say(c.channels[j], c.greeting);
                }
            }
        }
    }

}


// Just some random IRC event handlers to spit out useful info
function register_handlers(client) {
    client.on('error', function(err) {
        console.log('error ', err);
    });

    if(cli.options.debug) {
        client.on('registered', function(e) { console.log('registered ', e); });
        client.on('motd', function(motd) { console.log('MOTD ', 'motd', motd); });
        client.on('names', function(channel, nicks) { console.log('NAMES ', 'channel', channel, 'nicks', nicks); });
        client.on('topic', function(channel, topic, nick) { console.log('TOPIC ', 'channel', channel, 'topic', topic, 'nick', nick); });
        client.on('join', function(channel, nick) { console.log('JOIN ', 'channel', channel, 'nick', nick); });
        client.on('pm', function(nick, text) { console.log('PM ', 'nick', nick, 'text', text); });
        client.on('raw', function(msg) { console.log('RAW ', msg); });

        client.on('message', function (from, to, message) {
            console.log('from ', from,' to ', to, ':', message);
        });
    }
}


/*** READ CONFIG FILE (also watch file for changes and reload) ***/

parse_conf_file();
fs.watchFile(cli.options.config, parse_conf_file);


/*** Run the HTTP server/handler ***/

http.createServer(function(req, res) {
    var reqParsed = url.parse(req.url, true);

    if(reqParsed.pathname == '/') {
        // If they don't pass in a url then dump the config out to them
        res.end(JSON.stringify(CONFIG));
    }
    else {
        // Otherwise look in the URL for /connectionname in our configs

        var urlParts = reqParsed.pathname.split('/');
        var connection = urlParts[1].toLowerCase();

        // Lookup the connection name in our connections list of irc clients
        if(IRC_CONNECTIONS[connection]) {
            (function (client) {
                var buffer = '';
                req.on('data', function(data) {
                    buffer += data;
                });

                req.on('end', function() {
                    if(cli.options.debug) {
                        console.log('POST DATA -> ', buffer);
                    }

                    var channels = client.CONFIG.channels || [];

                    // Run through all the channels for this connection and send the message
                    for(var i=0; i<channels.length; i++) {

                        if(reqParsed.query.topic) {
                            // Set the channel topic if we get that from the CGI param
                            client.send('TOPIC ' + channels[i] + ' ' + reqParsed.query.topic);
                        }

                        if(reqParsed.query.message) {
                            // If it was a GET style query with a "message" CGI param
                            client.say(channels[i], reqParsed.query.message);
                        }
                        else if(buffer.length > 0) {
                            // Otherwise dump the raw POSTed data
                            client.say(channels[i], buffer);
                        }
                    }

                    // close up the HTTP client connection
                    res.write('{"status":"success"}');
                    res.end();
                });

            })(IRC_CONNECTIONS[connection]);
        }
        else {
            res.end('{"status":"fail","message":"Connection doesn\'t exist " + connection"}');
        }
    }

}).listen(cli.options.http, function() {
    console.log('HTTP server running on http://localhost:' + cli.options.http);
});

