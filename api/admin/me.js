import { route } from "../_lib/http.js";
import { requireUser } from "../_lib/auth.js";
import { REASONS } from "../_lib/stock.js";

export default route({
  async GET(req, res) {
    const ctx = await requireUser(req, res);
    return { user: ctx.user, store: { name: ctx.storeName }, reasons: REASONS };
  },
});
