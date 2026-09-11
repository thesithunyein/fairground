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

  useEffect(() => {
    let mounted = true;

    const guestMethods: GuestApiV1 = {
      async setState(nextSnapshot) {
        if (!mounted) return;
        setSnapshot(nextSnapshot);
      },
    };

    const connection = connectGameToHost(guestMethods);

    void connection.promise
      .then(parent => {
        if (!mounted) return;
        setHostApi(parent);
        setMode('host');
      })
      .catch(() => {
        // Handshake failed — stay demo until timeout, then stay demo forever.
      });

    const timer = window.setTimeout(() => {
      if (mounted && modeRef.current === 'pending') setMode('demo');
    }, HANDSHAKE_TIMEOUT_MS);

    return () => {
      mounted = false;
      window.clearTimeout(timer);
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
