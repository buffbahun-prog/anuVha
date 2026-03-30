// networkState.ts

// ----------------- ENUM -----------------
export enum NetworkStatus {
  ONLINE = "online",           // Internet available (Wi-Fi or cellular)
  OFFLINE_LOCAL = "offline-local", // No internet, but connected to LAN/hotspot
  NO_NETWORK = "no-network"    // Neither internet nor local network
}

// ----------------- INTERNET CHECK -----------------
async function checkInternet(timeout = 3000): Promise<boolean> {
  if (!navigator.onLine) return false;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    await fetch("https://jsonplaceholder.typicode.com/posts/1", {
      method: "GET",
      cache: "no-store",
      mode: "no-cors",
      signal: controller.signal
    });

    clearTimeout(id);
    return true;
  } catch (err) {
    clearTimeout(id);
    return false;
  }
}

// ----------------- LOCAL NETWORK CHECK -----------------
async function hasLocalNetwork(): Promise<boolean> {
  return navigator.onLine;
}

// ----------------- MAIN FUNCTION -----------------
export async function getNetworkState(): Promise<NetworkStatus> {
  const online = await checkInternet();
  if (online) return NetworkStatus.ONLINE;

  const local = await hasLocalNetwork();
  if (local) return NetworkStatus.OFFLINE_LOCAL;

  return NetworkStatus.NO_NETWORK;
}