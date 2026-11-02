import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ApiProvider } from "./api/context";
import { createJouzuApi } from "./api/adapters";
import "./styles.css";
// Chat workspaces own a native runtime process. StrictMode's development-only
// double mount starts a second process while the first is still closing, which
// can leave a Flow branch attached. The desktop app mounts once.
const api = createJouzuApi();
async function boot() {
  try { await api.start(); } catch { /* The App surfaces the host error; it never falls back. */ }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <ApiProvider api={api}>
      <App />
    </ApiProvider>,
  );
}
void boot();
