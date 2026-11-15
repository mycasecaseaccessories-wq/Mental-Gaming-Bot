import type { Request } from "express";
export declare function isAllowedPortalRoute(req: Pick<Request, "method" | "originalUrl">): boolean;
