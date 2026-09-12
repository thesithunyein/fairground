import { useEffect, useRef, useState } from 'react';
import {
  connectGameToHost,
  observeGameContentSize,
  type GuestApiV1,
  type HostApiV1,
  type HostSnapshotV1,
} from '../chain-sdk/guest';

export type HostConnection = {
  hostApi: HostApiV1 | null;
  snapshot: HostSnapshotV1 | null;
  /** 'pending' until the handshake resolves or times out → 'host' | 'demo' */
  mode: 'pending' | 'host' | 'demo';
};

const HANDSHAKE_TIMEOUT_MS = 1200;
/** Host handshake resolved but no state arrived: fall back to demo (some
 *  embeds resolve postMessage without ever calling setState). A late
 *  snapshot still upgrades back to host mode. */
const SNAPSHOT_TIMEOUT_MS = 4000;

/**
 * Guest side of the casino bridge. If the handshake doesn't resolve quickly
 * (the game was opened directly — jam gallery, judges, anyone), the game
 * flips into standalone demo mode. Connecting late still upgrades to host
 * mode; demo state is discarded.
 */
export function useCasinoHost(): HostConnection {
  const [hostApi, setHostApi] = useState<HostApiV1 | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshotV1 | null>(null);
  const [mode, setMode] = useState<'pending' | 'host' | 'demo'>('pending');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const hostApiRef = useRef<HostApiV1 | null>(null);

  useEffect(() => {
    let mounted = true;
    let gotState = false;

    /* Opened directly, there is no host to wait for, so play at once instead of
       showing the connecting splash for the length of the handshake timeout.
       A pipe is only ever delivered through a parent frame, so a page that is
       its own top window can skip the wait. The connection still runs, so an
       embed that reaches us late (a gallery iframe, a host that boots slowly)
       upgrades from demo to host exactly as before. */
    const embedded = (() => {
      try { return window.parent !== window; } catch { return true; }
    })();
    if (!embedded) setMode('demo');

    const guestMethods: GuestApiV1 = {
      async setState(nextSnapshot) {
        if (!mounted) return;
        gotState = true;
        setSnapshot(nextSnapshot);
        // real host state arrived → (re)enter host mode even if we had
        // fallen back to demo while waiting for it
        if (hostApiRef.current) setMode('host');
      },
    };

    const connection = connectGameToHost(guestMethods);

    void connection.promise
      .then(parent => {
        if (!mounted) return;
        hostApiRef.current = parent;
        setHostApi(parent);
        setMode('host');
      })
      .catch(() => {
        // Handshake failed — stay demo until timeout, then stay demo forever.
      });

    const timer = window.setTimeout(() => {
      if (mounted && modeRef.current === 'pending') setMode('demo');
    }, HANDSHAKE_TIMEOUT_MS);

    const snapshotTimer = window.setTimeout(() => {
      // handshake resolved but the host never pushed state — some embeds do
      // postMessage without a real host behind them. Play demo; a late
      // setState still flips us back to host mode.
      if (mounted && modeRef.current === 'host' && !gotState) setMode('demo');
    }, SNAPSHOT_TIMEOUT_MS);

    return () => {
      mounted = false;
      window.clearTimeout(timer);
      window.clearTimeout(snapshotTimer);
      connection.destroy();
    };
  }, []);

  useEffect(() => {
    if (!hostApi) return;
    const observer = observeGameContentSize(hostApi);
    return () => observer.disconnect();
  }, [hostApi]);

  return { hostApi, snapshot, mode };
}
