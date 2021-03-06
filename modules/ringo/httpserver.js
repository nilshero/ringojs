/**
 * @fileOverview A wrapper for the Jetty HTTP server.
 */

var log = require('ringo/logging').getLogger(module.id);
var Parser = require('ringo/args').Parser;
var system = require('system');
var {WebSocket, WebSocketServlet} = org.eclipse.jetty.websocket;

export('Server', 'main');

var options,
    server,
    parser,
    started = false;

/**
 * Create a Jetty HTTP server with the given options. The options may
 * either define properties to be used with the default jetty.xml, or define
 * a custom configuration file.
 *
 * @param {Object} options A javascript object with any of the following properties,
 * with the default value in parentheses:
 * <ul>
 * <li>jettyConfig ('config/jetty.xml')</li>
 * <li>port (8080)</li>
 * <li>host (undefined)</li>
 * </ul>
 *
 * For convenience, the constructor supports the definition of a JSGI application
 * and static resource mapping in the config object using the following properties:
 * <ul>
 * <li>virtualHost (undefined)</li>
 * <li>mountpoint ('/')</li>
 * <li>staticDir ('static')</li>
 * <li>staticMountpoint ('/static')</li>
 * <li>config ('config')</li>
 * <li>app ('app')</li>
 * </ul>
 */
function Server(options) {

    if (!(this instanceof Server)) {
        return new Server(options);
    }

    // the jetty server instance
    var jetty;
    var defaultContext;
    var contextMap = {};
    var xmlconfig;

    /**
     * Get the server's default context. The default context is the
     * context that is created when the server is created.
     * @since: 0.6
     * @returns the default context
     */
    this.getDefaultContext = function() {
        return defaultContext;
    };

    /**
     * Get a servlet application context for the given path and virtual hosts, creating
     * it if it doesn't exist.
     * @param {string} path the context root path such as "/" or "/app"
     * @param {string|array} virtualHosts optional single or multiple virtual host names.
     *   A virtual host may start with a "*." wildcard.
     * @param {Object} options may have the following properties:
     *   sessions: true to enable sessions for this context, false otherwise
     *   security: true to enable security for this context, false otherwise
     * @since: 0.6
     * @returns a Context object
     */
    this.getContext = function(path, virtualHosts, options) {
        var idMap = xmlconfig.getIdMap();
        options = options || {};
        var contextKey = virtualHosts ? String(virtualHosts) + path : path;
        var cx = contextMap[contextKey];
        if (!cx) {
            var contexts = idMap.get("Contexts");
            var sessions = Boolean(options.sessions);
            var security = Boolean(options.security);
            cx = new org.eclipse.jetty.servlet.ServletContextHandler(contexts, path, sessions, security);
            if (virtualHosts) {
                cx.setVirtualHosts(Array.isArray(virtualHosts) ? virtualHosts : [String(virtualHosts)]);
            }
            contextMap[contextKey] = cx;
            if (jetty.isRunning()) {
                cx.start();
            }
        }

        return {
            /**
             * Map this context to a JSGI application.
             * @param {function|object} app a JSGI application, either as a function or an object
             *   with properties <code>config</code> and <code>app</code> defining
             *   the application.
             *   <div><code>{ config: 'config', app: 'app' }</code></div>
             * @param {RhinoEngine} engine optional RhinoEngine instance for multi-engine setups
             * @since: 0.6
             * @name Context.instance.serveApplication
             */
            serveApplication: function(app, engine) {
                log.debug("Adding JSGI application:", cx, "->", app);
                engine = engine || require('ringo/engine').getRhinoEngine();
                var isFunction = typeof app === "function";
                var servlet = isFunction ?
                              new JsgiServlet(engine, app) :
                              new JsgiServlet(engine);
                var jpkg = org.eclipse.jetty.servlet;
                var servletHolder = new jpkg.ServletHolder(servlet);
                if (!isFunction) {
                    servletHolder.setInitParameter('config', app.config || 'config');
                    servletHolder.setInitParameter('app', app.app || 'app');
                }
                cx.addServlet(servletHolder, "/*");
            },
            /**
             * Map this context to a directory containing static resources.
             * @param {string} dir the directory from which to serve static resources
             * @since: 0.6
             * @name Context.instance.serveStatic
             */
            serveStatic: function(dir) {
                log.debug("Adding static handler:", cx, "->", dir);
                var repo = getRepository(dir);
                cx.setResourceBase(repo.exists() ? repo.getPath() : dir);
                var jpkg = org.eclipse.jetty.servlet;
                var servletHolder = new jpkg.ServletHolder(jpkg.DefaultServlet);
                cx.addServlet(servletHolder, "/*");
            },
            /**
             * Map a request path within this context to the given servlet.
             * @param {string} servletPath the servlet path
             * @param {Servlet} servlet a java object implementing the javax.servlet.Servlet interface.
             * @param {Object} initParams optional object containing servlet init parameters
             * @since: 0.6
             * @name Context.instance.addServlet
             */
            addServlet: function(servletPath, servlet, initParams) {
                log.debug("Adding Servlet:", servletPath, "->", servlet);
                var jpkg = org.eclipse.jetty.servlet;
                var servletHolder = new jpkg.ServletHolder(servlet);
                for (var p in initParams) {
                    servletHolder.setInitParameter(p, initParams[p])
                }
                cx.addServlet(servletHolder, servletPath);
            },
            /**
             * Start accepting WebSocket connections in this context context.
             *
             * @param path The URL path on which to accept WebSocket connections
             * @param onconnect a function called for each new WebSocket connection
             *        with the WebSocket object as argument.
             * @since 0.8
             * @see WebSocket
             * @name Context.instance.addWebSocket
             */
            addWebSocket: function(path, onconnect) {
                log.info("Starting websocket support");
                this.addServlet(path, new WebSocketServlet({
                    doWebSocketConnect : function(request, protocol) {
                        log.debug("new websocket");
                        var socket;

                        return new WebSocket({
                            onConnect: function(outbound) {
                                log.debug("onconnect");

                                /**
                                 * The WebSocket object passed as argument to the `connect` callback.
                                 * Assign callbacks to its [onmessage](#WebSocket.prototype.onmessage)
                                 * and [onclose](#WebSocket.prototype.onclose) properties.
                                 * @name WebSocket
                                 * @class
                                 */
                                socket = {
                                    /**
                                     * Closes the WebSocket connection.
                                     * @name WebSocket.instance.close
                                     * @function
                                     */
                                    close: function() {
                                        outbound.disconnect();
                                    },
                                    /**
                                     * Send a string over the WebSocket.
                                     * @param msg a string
                                     * @name WebSocket.instance.send
                                     * @function
                                     */
                                    send: function(msg) {
                                        outbound.sendMessage(msg);
                                    },
                                    /**
                                     * Check whether the WebSocket is open.
                                     * @name WebSocket.instance.isOpen
                                     * @function
                                     */
                                    isOpen: function() {
                                        return outbound.isOpen();
                                    },
                                    /**
                                     * Callback slot for receiving messages on this WebSocket. To receive
                                     * messages on this WebSocket, assign a function to this property.
                                     * The function is called with a single argument containing the message string.
                                     * @name WebSocket.instance.onmessage
                                     */
                                    onmessage: null,
                                    /**
                                     * Callback slot for getting notified when the WebSocket is closed.
                                     * To get called when the WebSocket is closed assign a function to this
                                     * property. The function is called without arguments.
                                     * @name WebSocket.instance.onclose
                                     */
                                    onclose: null
                                };
                                if (typeof onconnect === "function") {
                                    onconnect(socket)
                                }
                            },

                            onMessage: function(frame, data) {
                                log.debug("onmessage");
                                if (typeof socket.onmessage === "function") {
                                    socket.onmessage(data);
                                }
                            },

                            onDisconnect: function() {
                                log.debug("ondisconnect");
                                if (typeof socket.onclose === "function") {
                                    socket.onclose();
                                }
                            }
                        });
                    }
                }));
            }
        };
    };

    /**
     * Start the HTTP server.
     */
    this.start = function() {
        jetty.start();
        log.info('Server on http://' + (props.get('host') || 'localhost') +
                ':' + props.get('port') + ' started.');
    };

    /**
     * Stop the HTTP server.
     */
    this.stop = function() {
        jetty.stop();
        contextMap = {};
    };

    /**
     * Destroy the HTTP server, freeing its resources.
     */
    this.destroy = function() {
        jetty.destroy();
    };

    /**
     * Checks whether this server is currently running.
     * @returns true if the server is running, false otherwise.
     */
    this.isRunning = function() {
        return jetty != null && jetty.isRunning();
    };

    /**
     * Get the Jetty server instance
     * @returns the Jetty Server instance
     */
    this.getJetty = function() {
        return jetty;
    };

    options = options || {};

    var jettyFile = options.jettyConfig || 'config/jetty.xml';
    var jettyConfig = getResource(jettyFile);
    if (!jettyConfig.exists()) {
        throw Error('Resource "' + jettyFile + '" not found');
    }
    var XmlConfiguration = org.eclipse.jetty.xml.XmlConfiguration;
    var JsgiServlet = org.ringojs.jsgi.JsgiServlet;
    jetty = new org.eclipse.jetty.server.Server();
    xmlconfig = new XmlConfiguration(jettyConfig.inputStream);
    // port config is done via properties
    var props = xmlconfig.getProperties();
    props.put('port', (options.port || 8080).toString());
    if (options.host) props.put('host', options.host);
    xmlconfig.configure(jetty);

    // create default context
    defaultContext = this.getContext(options.mountpoint || "/", options.virtualHost, {
        security: true,
        sessions: true
    });

    // If options defines an application mount it
    if (typeof options.app === "function") {
        defaultContext.serveApplication(options.app);
    } else if (options.app && options.config) {
        defaultContext.serveApplication(options);
    }

    // Allow definition of app/static mappings in server config for convenience
    if (options.staticDir) {
        var files = require('ringo/utils/files');
        var staticContext = this.getContext(options.staticMountpoint || '/static', options.virtualHost);
        staticContext.serveStatic(files.resolveId(options.config, options.staticDir));
    }

    // Start listeners. This allows us to run on privileged port 80 under jsvc
    // even as non-root user if the constructor is called with root privileges
    // while start() is called with the user we will actually run as
    var connectors = jetty.getConnectors();
    for each (var connector in connectors) {
        connector.open();
    }

}


function parseOptions(arguments, defaults) {
    // parse command line options
    parser = new Parser();
    parser.addOption("a", "app", "APP", "The exported property name of the JSGI app (default: 'app')");
    parser.addOption("c", "config", "MODULE", "The module containing the JSGI app (default: 'config')");
    parser.addOption("j", "jetty-config", "PATH", "The jetty xml configuration file (default. 'config/jetty.xml')");
    parser.addOption("H", "host", "ADDRESS", "The IP address to bind to (default: 0.0.0.0)");
    parser.addOption("m", "mountpoint", "PATH", "The URI path where to mount the application (default: /)");
    parser.addOption("p", "port", "PORT", "The TCP port to listen on (default: 80)");
    parser.addOption("s", "static-dir", "DIR", "A directory with static resources to serve");
    parser.addOption("S", "static-mountpoint", "PATH", "The URI path where ot mount the static resources");
    parser.addOption("v", "virtual-host", "VHOST", "The virtual host name (default: undefined)");
    parser.addOption("h", "help", null, "Print help message to stdout");
    options = parser.parse(arguments, defaults);
    if (options.port && !isFinite(options.port)) {
        var port = parseInt(options.port, 10);
        if (isNaN(port) || port < 1) {
            throw "Invalid value for port: " + options.port;
        }
        options.port = port;
    }
    return options;
}

/**
 * Main webapp startup function.
 * @param {String} path optional path to the web application directory or config module.
 */
function main(path) {
    // protect against module reloading
    if (started) {
        return server;
    }
    // parse command line options
    var cmd = system.args.shift();
    try {
        options = parseOptions(system.args, {
            app: "app",
            config: "config"
        });
    } catch (error) {
        print(error);
        system.exit(1);
    }

    if (options.help) {
        print("Usage:");
        print("", cmd, "[OPTIONS]", "[PATH]");
        print("Options:");
        print(parser.help());
        system.exit(0);
    }

    var appDir = "";
    // if no explicit path is given use first command line argument
    path = path || system.args[0];
    var fs = require("fs");
    if (path) {
        try {
            // check if argument can be resolved as module id
            require(path);
            options.config = path;
        } catch (error) {
            path = fs.absolute(path);
            if (fs.isDirectory(path)) {
                // if argument is a directory assume app in config.js
                options.config = fs.join(path, "config");
                appDir = path;
            } else {
                // if argument is a file use it as config module
                options.config = path;
                appDir = fs.directory(path);
            }
        }
    } else {
        appDir = fs.workingDirectory();
        options.config = fs.join(appDir, "config");
    }

    // logging module is already loaded and configured, check if webapp provides
    // its own log4j configuration file and apply it if so.
    var logConfig = getResource(fs.join(appDir, "config/log4j.properties"));
    if (logConfig.exists()) {
        require("./logging").setConfig(logConfig);
    }

    server = new Server(options);
    server.start();
    started = true;
    // return the server instance
    return server;
}

if (require.main == module) {
    main();
}

