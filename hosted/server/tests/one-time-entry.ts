import worker, { OneTimeRoom as ProductionRoom } from "../relay-worker";
import { TEST_ROOM_LIMITS } from "./one-time-limits";

/** The production room on timings a test can wait out. */
export class OneTimeRoom extends ProductionRoom {
  protected override limits() {
    return TEST_ROOM_LIMITS;
  }
}

export default worker;
