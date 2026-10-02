import { route } from "../_lib/http.js";
import { destroySession } from "../_lib/auth.js";

export default route({
  async POST(req, res) {
    await destroySession(req, res);
    return { ok: true };
  },
});
