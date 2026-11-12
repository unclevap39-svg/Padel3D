import type { Link, NetMsg } from './protocol';

const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

/**
 * Direct connection between the two players' browsers (WebRTC data channels): one reliable
 * channel for events and one that may drop packets for the high-rate state and controls.
 */
class RtcLink implements Link {
  onMessage: (msg: NetMsg) => void = () => {};
  onClose: () => void = () => {};
  private reliable: RTCDataChannel | null = null;
  private fast: RTCDataChannel | null = null;
  private closed = false;
  private lostTimer = 0;
  readonly pc: RTCPeerConnection;
  private resolveOpen: () => void = () => {};
  /** Resolves when both channels are open. */
  readonly ready: Promise<void>;

  constructor(pc: RTCPeerConnection) {
    this.pc = pc;
    this.ready = new Promise((res) => (this.resolveOpen = res));
    pc.addEventListener('connectionstatechange', () => {
      const st = pc.connectionState;
      window.clearTimeout(this.lostTimer);
      if (st === 'failed' || st === 'closed') this.shutdown();
      // A short network hiccup recovers by itself; give it a few seconds before giving up.
      else if (st === 'disconnected') this.lostTimer = window.setTimeout(() => this.shutdown(), 6000);
    });
  }

  attach(ch: RTCDataChannel): void {
    if (ch.label === 'r') this.reliable = ch;
    else this.fast = ch;
    ch.addEventListener('open', () => {
      if (this.open) this.resolveOpen();
    });
    ch.addEventListener('close', () => this.shutdown());
    ch.addEventListener('message', (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as NetMsg);
      } catch {
        // Ignore malformed packets.
      }
    });
    if (this.open) this.resolveOpen();
  }

  get open(): boolean {
    return !this.closed && this.reliable?.readyState === 'open' && this.fast?.readyState === 'open';
  }

  send(msg: NetMsg, fast?: boolean): void {
    const ch = fast ? this.fast : this.reliable;
    if (this.closed || !ch || ch.readyState !== 'open') return;
    // Skip a state update rather than queue it behind a congested link.
    if (fast && ch.bufferedAmount > 64000) return;
    try {
      ch.send(JSON.stringify(msg));
    } catch {
      // Channel closing: the close handler takes over.
    }
  }

  close(): void {
    this.shutdown(true);
  }

  private shutdown(silent = false): void {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.lostTimer);
    try {
      this.pc.close();
    } catch {
      // already closed
    }
    if (!silent) this.onClose();
  }
}

/** Waits for the browser to list its network candidates so one message carries them all. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    window.setTimeout(done, 3000);
  });
}

export interface HostOffer {
  link: Link & { ready: Promise<void> };
  sdp: string;
  /** Call with the guest's answer to finish connecting. */
  accept(answerSdp: string): Promise<void>;
}

export async function createOffer(): Promise<HostOffer> {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const link = new RtcLink(pc);
  link.attach(pc.createDataChannel('r', { ordered: true }));
  link.attach(pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return {
    link,
    sdp: pc.localDescription!.sdp,
    accept: (answerSdp) => pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }),
  };
}

export async function createAnswer(offerSdp: string): Promise<{ link: Link & { ready: Promise<void> }; sdp: string }> {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const link = new RtcLink(pc);
  pc.addEventListener('datachannel', (e) => link.attach(e.channel));
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { link, sdp: pc.localDescription!.sdp };
}

export const rtcSupported = (): boolean => typeof RTCPeerConnection !== 'undefined';
