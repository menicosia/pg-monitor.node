// Mysql Monitor - an app to monitor availability of a MySQL database

var finalhandler = require('finalhandler') ;
var http = require('http') ;
var serveStatic = require('serve-static') ;
var strftime = require('strftime') ;
var url = require('url') ;
var mysql = require('mysql') ;
var pg = require('pg') ;
var redis = require('redis') ;
var util = require('util') ;
// var bindMySQL = require('./bind-mysql.js') ;

// CONFIGURE THESE
var numSecondsStore = 600 // Default 10 minutes

// Variables
var data = "" ;
var activateState = Boolean(false) ;
var localMode = Boolean(false) ;
var vcap_services = undefined ;
var pg_creds = [] ;
var mysql_creds = [] ;
var dbClient = undefined ;
var dbConnectState = Boolean(false) ;

var dbConnectTimer = undefined ;
var redisConnectTimer = undefined ;
var pingInterval = undefined ;

// REDIS DOCUMENTATION

// Each instance is responsible for recording its own activity in
// Redis. Because this is cloud foundry, there's only ever expected to
// be one of each index running ie there should be no conflicts of
// multiple instances updating the same data.  There are two pieces of
// data per instance: lastTime and a 600-bit list (used to be Bit array)
// which represents 10 min of data.
// Instance_0_Hash lastKeyUpdated 0-599 lastUpdate SECS
// Instance_0_List ...

var redis_creds = [] ;
var redisClient = undefined ;
var redisConnectionState = Boolean(false) ;

var lastUpdate ;

// Setup based on Environment Variables
// if (process.env.VCAP_SERVICES) {
//     vcap_services = JSON.parse(process.env.VCAP_SERVICES) ;

//     mysql_creds = bindMySQL.getMySQLCreds() ;
//     if (mysql_creds) {
//         activateState = true ;
//     } else {
//         console.log("No VCAP_SERVICES mysql bindings. Will attempt to connect via 'MYSQL_URI'")
//     }

//     if (vcap_services['redis']) {
//         redis_credentials = vcap_services["redis"][0]["credentials"] ;
//         console.log("Got access credentials to redis: " + redis_credentials["host"]
//                  + ":" + redis_credentials["port"]) ;
//     } else if (vcap_services['rediscloud']) {
//         redis_credentials = vcap_services["rediscloud"][0]["credentials"] ;
//         console.log("Got access credentials to redis: " + redis_credentials["hostname"]
//                  + ":" + redis_credentials["port"]) ;
//     } else if (vcap_services['p-redis']) {
//         redis_credentials = vcap_services["p-redis"][0]["credentials"] ;
//         console.log("Got access credentials to p-redis: " + redis_credentials["host"]
//                  + ":" + redis_credentials["port"]) ;
//     } else {
//         console.log("No VCAP_SERVICES redis bindings. Will attempt to connect via 'REDIS_CREDS'")
//     }
// }

if (process.env.VCAP_APP_PORT) { var port = process.env.VCAP_APP_PORT ;}
else { var port = 8080 ; }
if (process.env.CF_INSTANCE_INDEX) { var myIndex = JSON.parse(process.env.CF_INSTANCE_INDEX) ; }
else {
    myIndex = 0 ;
    console.log("CF not detected, checking ENV for PG_URI") ;
    if (process.env.PG_URI && process.env.REDIS_CREDS) {
        creds = process.env.REDIS_CREDS.split(":") ;
        if (3 != creds.length) {
            console.error("[ERROR] REDIS_CREDS environment variable must be colon separated host:port:password") ;
            process.exit(1) ;
        } else {
            redis_creds = { 'password' : creds[2], 'host' : creds[0], 'port' : creds[1] } ;
            pg_creds["connectionString"] = process.env.PG_URI ;
            pg_creds["connectionTimeoutMillis"] = 1000 ;
            activateState = true ;
        }
    } else {
        console.log("No PG_URI or REDIS_CREDS, will run in passive mode till configured; see /config endpoint.") ;
        activateState = false ;
    }
}

// Here lie the names of the Redis data structures that we'll read/write from
var myInstance = "Instance_" + myIndex + "_Hash" ;
var myInstanceBits = "Instance_" + myIndex + "_Bits" ;
var myInstanceList = "Instance_" + myIndex + "_List" ;

// Callback functions

function handleDBerror(err) {
    if (err) {
        console.warn("[db] ERROR: Issue with database: " + err.code) ;
        if (true == activateState) {
            pgConnect() ;
        }
    }
}
        
function handleDBend() {
    console.warn("[db] PG server closed connection.") ;
    if (true == activateState) {
        pgConnect() ;
    }
}

function handleDBConnect(err) {
    clearInterval(dbConnectTimer) ;
    dbConnectTimer = undefined ;
    if (err) {
        dbConnectState = false ;
        console.error("[db] ERROR: problem connecting to DB: " + err) ;
        if (activateState == true) {
            console.info("[db] Will attempt to reconnect every 1 seconds.") ;
            dbConnectTimer = setTimeout(pgConnect, 1000) ;
        }
        recordDBStatus(0) ;
    } else {
        dbConnectState = true ;
        console.log("[db] Connected to database. Commencing ping every 1s.") ;
        dbClient.on('error', handleDBerror) ;
        dbClient.on('end', handleDBend) ;
        pingInterval = setInterval(doPing, 1000) ;
    }
}

function handleDBping(err) {
    if (err) {
        console.error('Postgres connection error: ' + err) ;
        recordDBStatus(0) ;
        dbClient.end() ;
        clearInterval(pingInterval) ;
        pgConnect() ;
    } else {
        console.log("[" + myIndex + "] Server responded to ping.") ;
        recordDBStatus(1) ;
    }
}

function handleLastTime(err, res) {
    if (err) {
        console.error("Error from redis: " + err) ;
    } else {
        console.log("Setting lastUpdate to: " + res) ;
        lastTime = res ;
    }
}
function handleRedisConnect(message, err) {
    clearInterval(redisConnectTimer) ;
    redisConnectTimer = undefined ;
    switch (message) {
    case "error":
        redisConnectionState = false ;
        console.error("[redis] ERROR: Redis connection failed: " + err + "\n[redis] Will try again in 3s." ) ;
        redisConnectTimer = setTimeout(RedisConnect, 3000) ;
        break ;
    case "ready":
        redisConnectionState = true ;
        redisClient.hget(myInstance, "lastUpdate", handleLastTime) ;
        console.log("[redis] READY.") ;
        break ;
    default:
        console.warn("Redis connection result neither error nor ready?!") ;
        break ;
    }
}


// Helper functions
function recordDBStatusHelper(err, res, bool) {
    if (err) {
        console.log("Error from redis: " + err) ;
        // Assume that handleRedisConnect's on("error") will kick in?
    } else {
        // write a 1 to the current second in redis
        lastTime = res ;
        now = Date.now() ;
        if (now < lastTime) {
            console.error("Last updated time is in the future?! Waiting to catch up...")
        } else {
            if (bool) {
                redisClient.lpush(myInstanceList, 1) ;
            } else {
                redisClient.lpush(myInstanceList, 0) ;
                console.log("DB down: " + bool + " lastUpdate: " + now) ;
            }
            redisClient.ltrim(myInstanceList, 0, numSecondsStore-1) ;
            redisClient.hmset(myInstance, "lastUpdate", now) ;
        }
    }
}

function recordDBStatus(bool) {
    if (redisConnectionState) {
        redisClient.hget(myInstance, "lastUpdate", function(err, res) { recordDBStatusHelper(err, res, bool) ; }) ;
    }
}

function doPing() {
    dbClient.query("select null", handleDBping) ;
}

function pgConnect() {
    if (true == activateState) {
        console.log("[db] Attempting to connect to PG...") ;
        dbClient = new pg.Client(pg_creds)
        dbClient.connect(handleDBConnect) ;
    } else {
        dbClient = undefined ;
    }
}

function MySQLConnect() {
    if (activateState) {
        dbClient = mysql.createConnection(mysql_creds["uri"])
        dbClient.connect(handleDBConnect) ;
        // dbClient.on('error', handleDBConnect) ;
    } else {
        dbClient = undefined ;
    }
}

function RedisConnect() {
    if (redisClient) { redisClient.end(true) }
    if (activateState && redis_creds) {
        console.log("[redis] Attempting to connect to redis...") ;
        if (redis_creds["host"]) {
          redisClient = redis.createClient(redis_creds["port"], redis_creds["host"]) ;
        } else {
          redisClient = redis.createClient(redis_creds["port"], redis_creds["hostname"]) ;
        }
        if (! localMode) { redisClient.auth(redis_creds["password"]) ; }
        redisClient.on("error", function(err) { handleRedisConnect("error", err) }) ;
        redisClient.on("ready", function() { handleRedisConnect("ready", undefined) }) ;
    } else {
        redisClient = undefined ;
        redisConnectionState = false ;
    }
}

function handleBits(request, response, reply) {
    console.log("Returning array from Redis of length: " + reply.length) ;
    response.end(JSON.stringify(reply)) ;
    return(true) ;
}

function dispatchApi(request, response, method, query) {
    switch(method) {
    case "0bits":
        if (redisConnectionState) {
            redisClient.lrange('Instance_0_List', 0, -1, function (err, reply) {
                var req = request ;
                var res = response ;
                if (err) {
                    console.error('[ERROR] querying redis: ' + err) ;
                    process.exit(5) ;
                } else {
                    handleBits(req, res, reply) ;
                }
            } ) ;
            break ;
        } else {
            response.end(false) ;
        }
    }
}

function requestHandler(request, response) {
    data = "" ;
    requestParts = url.parse(request.url, true);
    rootCall = requestParts['pathname'].split('/')[1] ;
    console.log("Recieved request for: " + rootCall) ;
    switch (rootCall) {
    case "env":
	      if (process.env) {
	          data += "<p>" ;
		        for (v in process.env) {
		            data += v + "=" + process.env[v] + "<br>\n" ;
		        }
		        data += "<br>\n" ;
	      } else {
		        data += "<p> No process env? <br>\n" ;
	      }
        response.write(data) ;
	      break ;
    case "dbstatus":
        data += JSON.stringify({"dbStatus":dbConnectState}) ;
        response.write(data) ;
        break ;
    case "ping":
        if (dbConnectState) {
            doPing() ;
            data += "OK, will ping the DB. Watch the log for a response." ;
        } else {
            data += "I'm sorry, Dave, I can't do that. No connection to the database." ;
        }
        response.write(data) ;
        break ;
    case "api":
        var method = requestParts['pathname'].split('/')[2] ;
        dispatchApi(request, response, method, requestParts['query']) ;
        return true ; // short-circuit response.end below.
        break ;
    case "debug":
        // This is the old code that was the original index page.
        data += "<h1>MySQL Monitor</h1>\n" ;
        data += "<p>" + strftime("%Y-%m-%d %H:%M") + "<br>\n" ;
        data += "<p>Request was: " + request.url + "<br>\n" ;
        if (activateState) {
	          data += "Database connection info: " + mysql_creds["uri"] + "<br>\n" ;
        } else {
            data += "Database info is NOT SET</br>\n" ;
        }
        data += "</p\n<hr>\n" ;
        data += "<A HREF=\"" + url.resolve(request.url, "env") + "\">/env</A>  " ;
        data += "<A HREF=\"" + url.resolve(request.url, "ping") + "\">/ping</A>  " ;
        response.write(data) ;
        break ;
    case "config":
        if ("query" in requestParts
            && "db_host" in requestParts["query"] && "db_DB" in requestParts["query"]
            && "db_user" in requestParts["query"] && "db_pw" in requestParts["query"]) {
            console.log("Received DB connection info: " + requestParts["query"]["host"]) ;
            pg_creds["host"] = requestParts["query"]["db_host"] ;
            pg_creds["database"] = requestParts["query"]["db_DB"] ;
            pg_creds["user"] = requestParts["query"]["db_user"] ;
            pg_creds["password"] = requestParts["query"]["db_pw"] ;
            redis_creds["host"] = requestParts["query"]["redis_host"] ;
            redis_creds["user"] = requestParts["query"]["redis_user"] ;
            redis_creds["password"] = requestParts["query"]["redis_pw"] ;
            activateState = Boolean(true) ;
            console.log("Received setup details, attempting to connect to DB and Redis...") ;
            RedisConnect() ;
            pgConnect(response) ;
            
        } else {
            response.end("ERROR: Usage: /config?db_host=127.0.0.1&db_DB=mydb&db_user=postgres&db_pw=READCTED&redis_host=127.0.0.1&redis_port=6379&redis_pw=REDACTED "
                         + "(request: " + request.url  + ")\n") ;
        }
        return(true) ;
    default:
        console.log("Unknown request: " + request.url) ;
        response.statusCode = 404 ;
        response.statusMessage = http.STATUS_CODES[404] ;
        response.writeHead(404) ;
        response.write("<H1>404 - Not Found</H1>") ;
    }

    response.end() ;
}

// MAIN
var staticServer = serveStatic("static") ;
monitorServer = http.createServer(function(req, res) {
    var done = finalhandler(req, res) ;
    staticServer(req, res, function() { requestHandler(req, res, done) ; } ) ;
}) ;

monitorServer.listen(port) ;

if (activateState) {
    console.log("Connecting to database...") ;
    pgConnect() ;
    console.log("Connecting to Redis...") ;
    RedisConnect() ;
}

console.log("Server up and listening on port: " + port) ;
