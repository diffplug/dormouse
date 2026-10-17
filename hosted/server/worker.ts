import { accountApp } from "./account-app";
import { auth } from "./account-auth";
import { accountBindings } from "./bindings";
import { prelaunchAuth } from "./prelaunch";

/** The account Worker, `dormouse-hosted` on `hosted.dormouse.sh`. */
export default accountApp(prelaunchAuth(auth.fetch), accountBindings);
