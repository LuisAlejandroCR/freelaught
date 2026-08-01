import { getStats } from "../src/web/handlers.js";

export default function handler(req, res) {
  res.status(200).json(getStats());
}
