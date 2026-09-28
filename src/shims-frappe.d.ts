declare module "frappe-gantt" {
  export default class Gantt {
    constructor(wrapper: HTMLElement | string, tasks: unknown[], options?: unknown);
    refresh(tasks: unknown[]): void;
    change_view_mode(mode: string): void;
  }
}
