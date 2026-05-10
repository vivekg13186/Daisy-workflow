// Plugin registry — list of available action plugins for the workflow
// editor's node palette. Read-only. No workspace scoping (the registry
// is global, the same set of plugin types is available to every
// workspace) — but we still require the caller to be authenticated so
// an unauthenticated visitor can't inventory the plugin surface.

import { Router } from "express";
import { registry } from "../plugins/registry.js";
import { requireUser, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireUser);
router.get("/",
  requireRole("admin", "editor", "viewer"),
  (_req, res) => res.json(registry.list()),
);
export default router;
