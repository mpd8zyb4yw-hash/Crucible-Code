interface Window {
  electronIPC?: {
    send: (channel: string, ...args: unknown[]) => void;
  };
}
