import { accountApp } from "./account-app";
import { auth } from "./account-auth";
import { accountBindings } from "./bindings";

/** The account Worker, `dormouse-hosted` on `hosted.dormouse.sh`. */
export default accountApp(auth.fetch, accountBindings);
