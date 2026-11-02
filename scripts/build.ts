import { Task } from "@sshkeda/task";

import { build } from "../tests/index.ts";

if (import.meta.main) {
  Task.main(build);
}
