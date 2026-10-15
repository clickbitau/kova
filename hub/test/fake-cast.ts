import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { encodeMessage, decodeMessage, NS } from '../src/adapters/cast/channel.ts';

/** A fake Cast receiver: enough of receiver, media and multizone to drive the adapter. */
export function fakeCast(name: string, members: string[] = []) {
  const log: { ns: string; type: string; data: Record<string, unknown> }[] = [];
  const st = { app: null as null | { appId: string; sessionId: string; transportId: string }, level: 0.3, muted: false, url: '', title: '', repeat: 'REPEAT_OFF', paused: false, time: 0, deaf: false, refuse: null as RegExp | null, buffering: false };
  const socks: net.Socket[] = [];
  /** The speaker says its media stopped by itself (a fetch that failed: ERROR), unasked. */
  const idle = (idleReason: string) => { for (const k of socks) k.write(encodeMessage({ source: 'web-1', destination: 'sender-0', namespace: NS.media, data: { type: 'MEDIA_STATUS', requestId: 0, status: [{ mediaSessionId: 7, playerState: 'IDLE', idleReason }] } })); };
  const server = net.createServer(sock => {
    socks.push(sock);
    let buf = Buffer.alloc(0);
    const reply = (m: { source: string; namespace: string; data: Record<string, unknown> }) =>
      sock.write(encodeMessage({ source: m.source, destination: 'sender-0', namespace: m.namespace, data: m.data }));
    const status = (requestId: unknown) => ({ type: 'RECEIVER_STATUS', requestId, status: { volume: { level: st.level, muted: st.muted }, applications: st.app ? [st.app] : [] } });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const m = decodeMessage(buf.subarray(4, 4 + buf.readUInt32BE(0)));
        buf = buf.subarray(4 + buf.readUInt32BE(0));
        const type = String(m.data.type);
        log.push({ ns: m.namespace, type, data: m.data });
        // A receiver that stopped answering (stuck): heartbeats aside, nothing comes back.
        if (st.deaf && m.namespace !== NS.heartbeat) continue;
        const rid = m.data.requestId;
        if (m.namespace === NS.receiver) {
          if (type === 'LAUNCH') st.app = { appId: String(m.data.appId), sessionId: 'sess-1', transportId: 'web-1' };
          if (type === 'STOP') { st.app = null; st.url = ''; }
          if (type === 'SET_VOLUME') { const v = m.data.volume as { level?: number; muted?: boolean }; if (v.level != null) st.level = v.level; if (v.muted != null) st.muted = v.muted; }
          reply({ source: 'receiver-0', namespace: NS.receiver, data: status(rid) });
        } else if (m.namespace === NS.media && (type === 'LOAD' || type === 'QUEUE_LOAD') && st.refuse && st.refuse.test(String((m.data.media as { contentId?: string } | undefined)?.contentId ?? ''))) {
          reply({ source: 'web-1', namespace: NS.media, data: { type: 'LOAD_FAILED', requestId: rid } });
        } else if (m.namespace === NS.media && (type === 'LOAD' || type === 'QUEUE_LOAD')) {
          const media = (type === 'LOAD' ? m.data.media : (m.data.items as { media: unknown }[])[0]!.media) as { contentId: string; metadata?: { title?: string } };
          st.url = String(media.contentId);
          st.title = media.metadata?.title ?? '';
          st.repeat = String(m.data.repeatMode ?? 'REPEAT_OFF');
          st.paused = m.data.autoplay === false;
          st.time = Number(m.data.currentTime ?? 0);
          reply({ source: 'web-1', namespace: NS.media, data: { type: 'MEDIA_STATUS', requestId: rid, status: [{ mediaSessionId: 7, playerState: st.paused ? 'PAUSED' : 'PLAYING' }] } });
        } else if (m.namespace === NS.media && (type === 'GET_STATUS' || type === 'PAUSE' || type === 'PLAY' || type === 'SEEK' || type === 'QUEUE_UPDATE')) {
          if (type === 'PAUSE' || type === 'PLAY') { assert.equal(m.data.mediaSessionId, 7); st.paused = type === 'PAUSE'; }
          if (type === 'SEEK') st.time = Number(m.data.currentTime);
          reply({ source: 'web-1', namespace: NS.media, data: { type: 'MEDIA_STATUS', requestId: rid, status: st.app ? [{ mediaSessionId: 7, playerState: !st.url ? 'IDLE' : st.buffering ? 'BUFFERING' : st.paused ? 'PAUSED' : 'PLAYING', currentTime: st.time, repeatMode: st.repeat, ...(st.url ? { media: { contentId: st.url, metadata: { title: st.title } } } : {}) }] : [] } });
        } else if (m.namespace === NS.multizone) {
          reply({ source: 'receiver-0', namespace: NS.multizone, data: { type: 'MULTIZONE_STATUS', requestId: rid, status: { devices: members.map(id => ({ deviceId: id, name: id })) } } });
        }
      }
    });
  });
  return { server, log, st, name, idle, loads: () => log.filter(l => l.type === 'LOAD').length };
}

export async function listen(f: ReturnType<typeof fakeCast>) {
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r));
  return (f.server.address() as AddressInfo).port;
}

