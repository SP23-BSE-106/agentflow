/**
 * Versioned node-type registry.
 *
 * One description object per node type (name, displayName, group, version,
 * inputs/outputs, credentials, properties, defaults). The workflow builder
 * renders its node palette and its settings panel from these descriptions,
 * so adding a node type means adding a description — no hand-built form.
 *
 * Descriptions are original code written fresh for AgentFlow. The shape is
 * guided by the paraphrased behaviour in the n8n feature map
 * (~/workspace/fypagentflow-audit/n8n-feature-map.md); no n8n code is copied.
 */

export type NodePropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'stringArray'
  | 'collection'
  | 'credentials'
  | 'json';

export type NodeProperty = {
  name: string;
  displayName: string;
  type: NodePropertyType;
  default: unknown;
  options?: Array<{ name: string; value: string }>;
  description?: string;
  required?: boolean;
  displayOptions?: { show?: Record<string, unknown[]>; hide?: Record<string, unknown[]> };
};

export type NodeDescription = {
  name: string; // machine name, e.g. 'webhook'
  displayName: string; // e.g. 'Webhook'
  group: string[]; // e.g. ['trigger'] or ['transform']
  version: number; // 1
  inputs: string[]; // e.g. ['main']
  outputs: string[]; // e.g. ['main']; If has two outputs
  credentials?: Array<{ name: string; required?: boolean }>;
  properties: NodeProperty[];
  defaults: Record<string, unknown>;
  icon?: string;
  description?: string;
  webhooks?: boolean;
};

// name -> version -> description. Old workflows keep running on the version
// they were built with; the registry holds every shipped version side by side.
const byName = new Map<string, Map<number, NodeDescription>>();

/**
 * Aliases: old/saved names that resolve to a canonical registered type.
 * Canonical HTTP name is 'httpRequest' (builder/registry); 'http' is the
 * name the NodeType union used to list and that saved workflows (and the
 * repo's own n8n execution cases) carry, so it stays resolvable. Aliases
 * are NOT entries in `byName`, so they never appear as a second palette
 * entry in `listNodeTypes()` — they only make `getNodeType` resolve.
 */
const aliases = new Map<string, string>();

export function registerNodeAlias(alias: string, canonical: string): void {
  if (!alias || !canonical || alias === canonical) {
    throw new Error('registerNodeAlias: alias and canonical must be different non-empty names');
  }
  if (aliases.has(alias)) {
    throw new Error(`registerNodeAlias: alias '${alias}' is already registered`);
  }
  aliases.set(alias, canonical);
}

/** Resolve an alias to its canonical name, or the name itself. */
function canonicalName(name: string): string {
  return aliases.get(name) ?? name;
}

function checkDescription(desc: NodeDescription): void {
  if (!desc || typeof desc.name !== 'string' || !desc.name.trim()) {
    throw new Error('registerNodeType: description needs a non-empty name');
  }
  if (typeof desc.displayName !== 'string' || !desc.displayName.trim()) {
    throw new Error(`registerNodeType: node '${desc.name}' needs a non-empty displayName`);
  }
  if (!Number.isInteger(desc.version) || desc.version < 1) {
    throw new Error(`registerNodeType: node '${desc.name}' needs an integer version >= 1`);
  }
  if (!Array.isArray(desc.group) || desc.group.length === 0) {
    throw new Error(`registerNodeType: node '${desc.name}' needs at least one group`);
  }
  if (!Array.isArray(desc.inputs) || !Array.isArray(desc.outputs)) {
    throw new Error(`registerNodeType: node '${desc.name}' needs inputs and outputs arrays`);
  }
  if (!Array.isArray(desc.properties)) {
    throw new Error(`registerNodeType: node '${desc.name}' needs a properties array`);
  }
  for (const prop of desc.properties) {
    if (!prop || typeof prop.name !== 'string' || !prop.name.trim()) {
      throw new Error(`registerNodeType: node '${desc.name}' has a property without a name`);
    }
    if (!Object.prototype.hasOwnProperty.call(prop, 'default')) {
      throw new Error(`registerNodeType: node '${desc.name}' property '${prop.name}' needs a default`);
    }
    if (prop.type === 'options' && (!Array.isArray(prop.options) || prop.options.length === 0)) {
      throw new Error(`registerNodeType: node '${desc.name}' property '${prop.name}' is type 'options' but has no options`);
    }
  }
  if (!desc.defaults || typeof desc.defaults !== 'object') {
    throw new Error(`registerNodeType: node '${desc.name}' needs a defaults object`);
  }
}

export function registerNodeType(desc: NodeDescription): void {
  checkDescription(desc);
  let versions = byName.get(desc.name);
  if (!versions) {
    versions = new Map<number, NodeDescription>();
    byName.set(desc.name, versions);
  }
  if (versions.has(desc.version)) {
    throw new Error(`registerNodeType: node '${desc.name}' version ${desc.version} is already registered`);
  }
  versions.set(desc.version, desc);
}

export function getNodeType(name: string, version?: number): NodeDescription | undefined {
  const canonical = canonicalName(name);
  const versions = byName.get(canonical);
  if (!versions) return undefined;
  if (version === undefined) return versions.get(defaultVersion(canonical));
  return versions.get(version);
}

export function defaultVersion(name: string): number {
  const versions = byName.get(canonicalName(name));
  if (!versions || versions.size === 0) {
    throw new Error(`defaultVersion: no node type named '${name}' is registered`);
  }
  return Math.max(...versions.keys());
}

/**
 * Every registered node type at its default version. Pass a group
 * ('trigger', 'transform', 'output', 'organisation') to list only the
 * types in that group.
 */
export function listNodeTypes(group?: string): NodeDescription[] {
  const out: NodeDescription[] = [];
  for (const [name, versions] of byName) {
    const desc = versions.get(defaultVersion(name));
    if (!desc) continue;
    if (group === undefined || desc.group.includes(group)) out.push(desc);
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}
