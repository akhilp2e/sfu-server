const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(3000, () => {
  console.log('Server is listening on port 3000');
});
app.use(express.json());

app.post('/create-producer', async (req, res) => {
  const { kind, rtpParameters } = req.body;

  if (!transport) {
    return res.status(400).json({ error: 'No transport available' });
  }

  const producer = await transport.produce({
    kind,
    rtpParameters,
  });

  producers.set(producer.id, producer);

  res.json({ producerId: producer.id });
});
(async () => {
  const worker = await mediasoup.createWorker();
  const router = await worker.createRouter();

  const rooms = new Map();

  wss.on('connection', (ws) => {
    console.log('WebSocket connection established.');

    let transport;
    let producer;
    let room;

    ws.on('message', async (message) => {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'createTransport':
          transport = await router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
          });

          ws.send(JSON.stringify({
            event: 'transportCreated',
            transportOptions: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          }));
          break;
        case 'connectTransport':
          await transport.connect({
            dtlsParameters: msg.dtlsParameters,
          });
          break;
        case 'produce':
          producer = await transport.produce({
            kind: msg.kind, // 'audio' or 'video'
            rtpParameters: msg.rtpParameters,
          });

          ws.send(JSON.stringify({
            event: 'producerCreated',
            producerId: producer.id,
          }));
          break;
        case 'joinRoom':
          const roomId = msg.roomId;

          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
          }

          room = rooms.get(roomId);
          room.add(ws);

          ws.send(JSON.stringify({
            event: 'joinedRoom',
            peers: Array.from(room).map(peer => peer.peerId),
          }));

          broadcastToRoom(room, {
            event: 'peerJoined',
            peerId: ws.peerId,
          });
          break;
        case 'handleRemoteIceCandidate':
          const candidate = msg.candidate;
          if (producer && producer.kind === 'video') {
            await producer.addIceCandidate(candidate);
          } else if (transport) {
            await transport.addIceCandidate(candidate);
          }
          break;
        default:
          console.warn('Unknown message event:', msg.event);
          break;
      }
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed.');

      if (transport) {
        transport.close();
      }

      if (producer) {
        producer.close();
      }

      if (room) {
        room.delete(ws);
        broadcastToRoom(room, {
          event: 'peerLeft',
          peerId: ws.peerId,
        });
      }
    });
  });

  function broadcastToRoom(room, message) {
    room.forEach(peer => peer.send(JSON.stringify(message)));
  }
})();
