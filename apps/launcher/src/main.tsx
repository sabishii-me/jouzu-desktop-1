import ReactDOM from "react-dom/client";
import { App } from "./App";
import { HostDesktop } from "./HostDesktop";
import { ApiProvider } from "./api/context";
import { createJouzuApi } from "./api/adapters";
import { HostChatTransport } from "./host-chat-transport";
import { setChatTransportFactory } from "./chat-pool";
import "./styles.css";
// Chat workspaces own a native runtime process. StrictMode's development-only
// double mount starts a second process while the first is still closing, which
// can leave a Flow branch attached. The desktop app mounts once.
const api = createJouzuApi();
if (!("__TAURI_INTERNALS__" in window)) {
  setChatTransportFactory(() => new HostChatTransport(api));
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ApiProvider api={api}>
    {api.capabilities.host && !api.capabilities.native ? <HostDesktop /> : <App />}
  </ApiProvider>,
);
