"use strict";

const { macToId } = require("./mqtt_ha_discovery");

const REGISTRY_PREFIX = "bm6bm7/registry";

function registryTopicForAddress(address) {
  const id = macToId(address);
  return `${REGISTRY_PREFIX}/${id}`;
}

function parseRegistryPayload(payload) {
  if (!payload) return null;
  try {
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== "object") return null;
    if (!obj.address) return null;
    return {
      address: String(obj.address).toLowerCase(),
      model: obj.model === "bm6" || obj.model === "bm7" ? obj.model : "",
      name: typeof obj.name === "string" ? obj.name : "",
      createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function buildRegistryPayload(entry) {
  return JSON.stringify(
    {
      address: entry.address,
      model: entry.model || "",
      name: entry.name || "",
      createdAt: entry.createdAt || "",
      updatedAt: entry.updatedAt || "",
    },
    null,
    2
  );
}

function mergeEntry(existing, incoming) {
  const nowIso = new Date().toISOString();
  const createdAt = existing && existing.createdAt ? existing.createdAt : nowIso;
  return {
    address: incoming.address,
    model: incoming.model || (existing && existing.model) || "",
    name: incoming.name || (existing && existing.name) || "",
    createdAt,
    updatedAt: nowIso,
  };
}

module.exports = {
  REGISTRY_PREFIX,
  registryTopicForAddress,
  parseRegistryPayload,
  buildRegistryPayload,
  mergeEntry,
};

