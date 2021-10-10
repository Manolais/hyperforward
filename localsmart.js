const hyperswarm = require('hyperswarm');
const crypto = require('crypto');
const net = require('net');
const pump = require('pump');
const noisePeer = require('noise-peer');
const utp = require('utp-native');
const fs = require('fs');
const sodium = require('sodium-native');
const argv = require('minimist')(process.argv.slice(2));
const homedir = require('os').homedir();

console.log('argv', argv);

// hyperforward -L 127.0.0.1:3000 --keys=crst --join=lks

let keys = (argv.keys || '').trim();
keys = 'noise' + (keys ? '_' + keys : '');
console.log('keys', keys);

let join = (argv.join || '').trim();
join = 'noise' + (join ? '_' + join : '');
console.log('join', join);

let localReverse = (argv.S || '').trim().split(':');
console.log('local', localReverse);

const serverPublicKey = Buffer.from(fs.readFileSync(homedir + '/.ssh/' + join + '.pub', 'utf8'), 'hex');
const clientKeys = {
  publicKey: Buffer.from(fs.readFileSync(homedir + '/.ssh/' + keys + '.pub', 'utf8'), 'hex'),
  secretKey: Buffer.from(fs.readFileSync(homedir + '/.ssh/' + keys, 'utf8'), 'hex')
};
const topic = discoveryKey(maybeConvertKey(serverPublicKey));

console.log('serverPublicKey', serverPublicKey);
console.log('clientKeys.publicKey', clientKeys.publicKey);
console.log('topic', topic);

const swarm = hyperswarm({
  announceLocalAddress: true
});

let reuseFirstSocket = true;

swarm.once('connection', (socket, info) => {
  console.log('new connection!', 'socket', socket.remoteAddress, socket.remotePort, socket.remoteFamily, 'type', info.type, 'client', info.client, 'info peer', info.peer ? [info.peer.host, info.peer.port, 'local?', info.peer.local] : info.peer, info.peer);

  socket.on('error', (err) => console.log('raw socket error', err));
  socket.on('end', () => console.log('raw socket ended'));
  socket.on('close', () => console.log('raw socket closed'));
  socket.on('error', socket.destroy);

  swarm.leave(topic, () => console.log('swarm leaved (connection)'));

  let myLocalServer = net.createServer(function onconnection (rawStream) {
    console.log('myLocalServer onconnection');

    if (info.client) {
      // reuse first socket or connect new one (tcp/utp)
      socket = reuseFirstSocket ? socket : (info.type === 'tcp' ? net : utp).connect(socket.remotePort, socket.remoteAddress);
      if (!reuseFirstSocket) {
        if (info.type === 'tcp') socket.setNoDelay(true);
        else socket.on('end', () => socket.end());

        socket.on('error', (err) => console.log('raw socket error', err));
        socket.on('end', () => console.log('raw socket ended'));
        socket.on('close', () => console.log('raw socket closed'));
        socket.on('error', socket.destroy);
      }
      reuseFirstSocket = false;
    } else {
      throw new Error('client is not client?');
    }

    let socketSecure = noisePeer(socket, true, {
      pattern: 'XK',
      staticKeyPair: clientKeys,
      remoteStaticKey: serverPublicKey
    });

    rawStream.on('error', (err) => {
      console.log('rawStream error', err);
    });
    rawStream.on('end', () => {
      console.log('rawStream end');
      socketSecure.end();
    });
    rawStream.on('close', () => {
      console.log('rawStream closed');
      socketSecure.end();
    });

    rawStream.on('data', (chunk) => {
      console.log('rawStream data', chunk.length);
      socketSecure.write(chunk);
    });
    socketSecure.on('data', (chunk) => {
      console.log('socketSecure data pre', chunk.length);
      if (rawStream.ending || rawStream.ended || rawStream.finished || rawStream.destroyed || rawStream.closed) {
        return;
      }
      console.log('socketSecure data post', chunk.length);
      rawStream.write(chunk);
    });

    socketSecure.on('error', (err) => {
      console.log('socketSecure error', err);
    });
    socketSecure.on('end', () => {
      console.log('socketSecure ended', info.type);
      rawStream.end();
    });
    socketSecure.on('close', () => {
      console.log('socketSecure closed', info.type);
    });
  });

  myLocalServer.listen(localReverse[1] || 0, localReverse[0], function () {
    let serverAddress = myLocalServer.address();
    console.log('local forward:', { address: serverAddress.address, port: serverAddress.port });
  });
});

/*swarm.on('disconnection', (socket, info) => {
  console.log('disconnection', 'socket?', socket ? true : false, 'type', info.type, 'client', info.client, 'info peer', info.peer ? [info.peer.host, info.peer.port, 'local?', info.peer.local] : info.peer);
  swarm.destroy();
});*/

swarm.on('updated', ({ key }) => {
  console.log('updated', key);

  if (!swarm.connections.size) {
    console.log('keep waiting an incoming connection..');
    // swarm.destroy();
  }
});

swarm.on('close', () => {
  console.log('swarm close');
  process.exit();
});

swarm.join(topic, {
  lookup: true,
  announce: false,
  // maxPeers: 1,
});

process.once('SIGINT', function () {
  swarm.once('close', function () {
    process.exit();
  });
  swarm.destroy();
  setTimeout(() => process.exit(), 2000);
});

function createHash (algo, name) {
  return crypto.createHash(algo).update(name).digest();
}

function discoveryKey (publicKey) {
  const buf = Buffer.alloc(32);
  const str = Buffer.from('hyperforward');
  sodium.crypto_generichash(buf, str, publicKey);
  return buf
}

function maybeConvertKey (key) {
  return typeof key === 'string' ? Buffer.from(key, 'hex') : key;
}

function maybeConvertKeyPair (keys) {
  return {
    publicKey: maybeConvertKey(keys.publicKey),
    secretKey: maybeConvertKey(keys.secretKey)
  };
}
