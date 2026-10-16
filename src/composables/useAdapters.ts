import { ref, onMounted, onUnmounted } from "vue";

export interface AdapterStatusLite {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  connected: boolean;
  lastError: string;
  ownerAccount: string | null;
  knownAccounts: string[];
  config?: Record<string, unknown>;
}

export interface AdapterConfigInput {
  type: "onebot" | "qqofficial";
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  ownerAccount?: string | null;
}

export function useAdapters() {
  const adapters = ref<AdapterStatusLite[]>([]);

  function getApi(): any {
    return (window as unknown as { botAdapterApi?: any }).botAdapterApi;
  }

  async function refresh() {
    const api = getApi();
    if (api?.list) {
      try {
        adapters.value = await api.list();
      } catch {
        /* ignore */
      }
    }
  }

  async function add(cfg: AdapterConfigInput) {
    const api = getApi();
    if (api?.add) {
      await api.add(cfg);
      await refresh();
    }
  }
  async function update(id: string, patch: Record<string, unknown>) {
    const api = getApi();
    if (api?.update) {
      await api.update(id, patch);
      await refresh();
    }
  }
  async function remove(id: string) {
    const api = getApi();
    if (api?.remove) {
      await api.remove(id);
      await refresh();
    }
  }
  async function connect(id: string) {
    const api = getApi();
    if (api?.connect) {
      await api.connect(id);
      await refresh();
    }
  }
  async function disconnect(id: string) {
    const api = getApi();
    if (api?.disconnect) {
      await api.disconnect(id);
      await refresh();
    }
  }
  /** 返回 { ownerAccount, moved }；moved = 顺带并进主对话的旧私聊记录条数。 */
  async function setOwner(adapterId: string, accountKey: string) {
    const api = getApi();
    if (!api?.setOwner) return { ownerAccount: null, moved: 0 };
    const res = await api.setOwner(adapterId, accountKey);
    await refresh();
    return res;
  }

  let onStatus: ((s: AdapterStatusLite[]) => void) | null = null;
  onMounted(() => {
    const api = getApi();
    if (api?.onStatus) {
      onStatus = (s: AdapterStatusLite[]) => {
        adapters.value = s;
      };
      api.onStatus(onStatus);
    }
    refresh();
  });
  onUnmounted(() => {
    onStatus = null;
  });

  return { adapters, refresh, add, update, remove, connect, disconnect, setOwner };
}
