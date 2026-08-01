import { getEventDetail } from "../../src/web/handlers.js";

export default function handler(req, res) {
  const { id } = req.query;
  const detail = getEventDetail(id);
  if (!detail) return res.status(404).json({ error: "event not found" });
  res.status(200).json(detail);
}
