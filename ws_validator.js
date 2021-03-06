var WebSocket = require('ws');
var exit = require('./lib/exit');

var jwt = require('jsonwebtoken');
var nconf = require('nconf');
var fs = require('fs');
var Users = require('./lib/users');
var users = new Users();
var async = require('async');
var randomstring = require('randomstring');

var cert = {
  key:  fs.readFileSync(__dirname + '/certs/cert.key'),
  cert: fs.readFileSync(__dirname + '/certs/cert.pem')
};

var socket_server_address = nconf.get('AD_HUB').replace(/^http/i, 'ws');
var ws = module.exports = new WebSocket(socket_server_address);

var WrongPassword = require('./lib/errors/WrongPassword');
var WrongUsername = require('./lib/errors/WrongUsername');

ws.sendEvent = function (name, payload) {
  this.send(JSON.stringify({
    n: name,
    p: payload
  }));
};

ws.reply = function (pid, response) {
  return this.sendEvent(pid + '_result', response);
};

function ping (client, count, callback) {
  if (typeof count === 'undefined') {
    count = 0;
    callback = function(){};
  }

  var hash = randomstring.generate(7);

  var on_pong = function (data) {
    if (data.toString() !== hash) return;
    clearTimeout(check);
    callback(null, {
      failed_pings: count
    });
  };

  var check = setTimeout(function () {
    client.removeListener('pong', on_pong);
    if (count === 4) {
      return callback(new Error('server didnt respond to 4 ping commands'));
    }
    console.log('Server didnt respond to ' + (count + 1) + ' ping commands. Re-ping.');
    ping(client, ++count, callback);
  }, 4000);

  client.on('pong', on_pong).ping(hash);
}

var log_from_auth0 = console.log.bind(console, 'auth0'.blue + ':');

console.log('Connecting to ' + socket_server_address.green + '.');

ws.on('open', function () {
  authenticate_connector();
}).on('message', function (msg) {
  var m;
  try {
    m = JSON.parse(msg);
  } catch (er) {
    return;
  }
  if (!m || !m.n) return;
  this.emit(m.n, m.p);
}).on('error', function (err) {
  console.error('Socket error: ' + err);
  exit(1);
}).on('authenticated', function () {
  log_from_auth0('Agent accepted.');
  var client = this;

  async.whilst(
    function () { return true; },
    function (done) {
      setTimeout(function () {
        ping(client, 0, function (err, result) {
          if (err) return done(err);
          if (result.failed_pings > 0) {
            console.log('Ping success after failed ' + result.failed_pings + ' pings.');
          }
          done();
        });
      }, 5000);
    },
    function (err) {
      console.log(err.message);
      return exit(1);
    }
  );

}).on('authentication_failure', function () {
  log_from_auth0('Agent ' + 'rejected'.red + '.');
  exit(0);
}).on('close', function () {
  if (process.exiting) {
    log_from_auth0('Connection closed as requested.');
  } else {
    log_from_auth0('Connection closed.');
    exit(1);
  }
}).on('authenticate_user', function (msg) {
  jwt.verify(msg.jwt, nconf.get('TENANT_SIGNING_KEY'), function (err, payload) {
    if (err) {
      console.error('Unauthorized attemp of authentication.');
      return;
    }

    var log_prepend = 'user ' + payload.username + ':';

    var log = console.log.bind(console, log_prepend.blue);

    log('Starting authentication attempt.');

    users.validate(payload.username, payload.password, function (err, user) {
      if (err) {
        if (err instanceof WrongPassword) {
          log("Authentication attempt failed. Reason: " + "wrong password".red);
          return ws.reply(payload.pid, { err: err, profile: err.profile });
        }
        if (err instanceof WrongUsername) {
          log("Authentication attempt failed. Reason: " + "wrong username".red);
          return ws.reply(payload.pid, { err: err, profile: { username: payload.username } });
        }
        log("Authentication attempt failed. Reason: " + "unexpected error".red);

        console.error('Inner error:', err.inner.stack);

        ws.reply(payload.pid, { err: err });
        return exit(1);
      }

      log('Authentication succeeded.');

      ws.sendEvent(payload.pid + '_result', { profile: user });
    });
  });
}).on('search_users', function (msg) {
  jwt.verify(msg.jwt, nconf.get('TENANT_SIGNING_KEY'), function (err, payload) {
    if (err) {
      console.error('Unauthorized attemp of search_users.');
      return;
    }

    console.log('Searching users.');

    var options = {
      limit: payload.limit
    };

    users.list(payload.search, options, function (err, users) {
      if (err) return ws.sendEvent(payload.pid + '_search_users_result', {err: err});
      console.log('Search succeeded.');
      ws.sendEvent(payload.pid + '_search_users_result', {
        users: users
      });
    });
  });
});

function authenticate_connector() {
  var token = jwt.sign({}, cert.key, {
    algorithm: 'RS256',
    expiresInMinutes: 1,
    issuer: nconf.get('CONNECTION'),
    audience: nconf.get('REALM')
  });
  ws.sendEvent('authenticate', { jwt: token });
}
