/**
 * BlueprintLLM - Structured business decomposition via LLM
 *
 * Voice: Analyst stating structure and tradeoffs, not a guide.
 * Rules:
 * - No number without stated basis. If unknown, mark basis: 'unknown'.
 * - Thin input yields small honest map naming what's missing, not fabrication.
 * - Confidence gated and visible on every node.
 * - Legal/financial content is scoping, not advice.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Initialize client (uses ANTHROPIC_API_KEY env var)
let anthropic = null;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic();
  }
  return anthropic;
}

// Schema for validation
const STAR_SCHEMA = {
  required: ['statement', 'detail', 'scores', 'confidence', 'stage', 'status'],
  scores: ['economy', 'orchestration', 'demand'],
  confidenceBasis: ['stated', 'inferred', 'unknown'],
  stages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  statuses: ['unexplored', 'mapped', 'kept', 'pruned', 'done'],
  constellations: ['offer', 'demand', 'delivery', 'economy', 'orchestration', 'risk']
};

const STAGE_NAMES = {
  0: 'Premise',
  1: 'Formation',
  2: 'Proof',
  3: 'Rights & Obligations',
  4: 'Build',
  5: 'Capital',
  6: 'Go-to-market',
  7: 'Unit Economics',
  8: 'Operate',
  9: 'Scale/Exit'
};

// Validate a star node against schema
function validateStar(node, context = '') {
  const errors = [];

  if (!node.statement || typeof node.statement !== 'string') {
    errors.push(`${context}: missing or invalid statement`);
  }
  if (!node.detail || typeof node.detail !== 'string') {
    errors.push(`${context}: missing or invalid detail`);
  }

  // Validate scores
  if (!node.scores || typeof node.scores !== 'object') {
    errors.push(`${context}: missing scores object`);
  } else {
    for (const axis of STAR_SCHEMA.scores) {
      if (!node.scores[axis] || typeof node.scores[axis].value !== 'number') {
        errors.push(`${context}: missing ${axis}.value`);
      }
      if (!node.scores[axis]?.reason) {
        errors.push(`${context}: missing ${axis}.reason`);
      }
    }
  }

  // Validate confidence
  if (!node.confidence || typeof node.confidence !== 'object') {
    errors.push(`${context}: missing confidence object`);
  } else {
    if (typeof node.confidence.value !== 'number') {
      errors.push(`${context}: missing confidence.value`);
    }
    if (!STAR_SCHEMA.confidenceBasis.includes(node.confidence.basis)) {
      errors.push(`${context}: invalid confidence.basis`);
    }
  }

  // Validate stage
  if (!STAR_SCHEMA.stages.includes(node.stage)) {
    errors.push(`${context}: invalid stage (must be 0-9)`);
  }

  // Validate status
  if (!STAR_SCHEMA.statuses.includes(node.status)) {
    errors.push(`${context}: invalid status`);
  }

  return errors;
}

// Validate complete nebula structure
function validateNebula(nebula) {
  const errors = [];

  if (!nebula.core) {
    errors.push('Missing core node');
  } else {
    errors.push(...validateStar(nebula.core, 'core'));
  }

  if (!nebula.constellations || !Array.isArray(nebula.constellations)) {
    errors.push('Missing constellations array');
  } else {
    for (let i = 0; i < nebula.constellations.length; i++) {
      const c = nebula.constellations[i];
      if (!STAR_SCHEMA.constellations.includes(c.constellation)) {
        errors.push(`constellation[${i}]: invalid constellation type`);
      }
      errors.push(...validateStar(c, `constellation[${i}]`));

      if (!c.children || !Array.isArray(c.children)) {
        errors.push(`constellation[${i}]: missing children array`);
      } else {
        for (let j = 0; j < c.children.length; j++) {
          errors.push(...validateStar(c.children[j], `constellation[${i}].children[${j}]`));
        }
      }
    }
  }

  return errors;
}

// System prompt for nebula generation
const NEBULA_SYSTEM_PROMPT = `You are Blueprint, an analyst that decomposes business premises into structured scoping maps.

Your output is ALWAYS valid JSON conforming to the star schema. Never return prose or explanation outside JSON.

STAR SCHEMA (every node must have):
{
  "statement": "Clear, actionable statement (max 200 chars)",
  "detail": "Elaboration with specifics (max 1000 chars)",
  "scores": {
    "economy": { "value": 0-10, "reason": "why this score" },
    "orchestration": { "value": 0-10, "reason": "why this score" },
    "demand": { "value": 0-10, "reason": "why this score" }
  },
  "confidence": {
    "value": 0-10,
    "basis": "stated" | "inferred" | "unknown"
  },
  "stage": 0-9 (see stage definitions),
  "status": "unexplored" | "mapped" | "kept" | "pruned" | "done",
  "dependencies": [], // nodeIds this depends on
  "cost": { // optional, include if estimable
    "capitalLow": number,
    "capitalHigh": number,
    "timeLow": number (days),
    "timeHigh": number (days),
    "basis": "why these estimates"
  },
  "sources": [] // references if any
}

STAGE DEFINITIONS:
0 = Premise (the core idea)
1 = Formation (entity, equity/vesting, IP assignment, cap table)
2 = Proof (validation, MVP, pilot)
3 = Rights & Obligations (licensing, IP, regulatory)
4 = Build (product development)
5 = Capital (funding, revenue, runway)
6 = Go-to-market (distribution, sales, marketing)
7 = Unit Economics (margins, LTV, CAC)
8 = Operate (team, processes, infrastructure)
9 = Scale/Exit (growth, M&A, IPO)

GROUNDING RULES (enforce strictly):
1. No number without stated basis. If unknown, say "basis: unknown" explicitly.
2. Thin input → small honest map that names what's missing. NEVER fabricate details.
3. Confidence is gated: stated (user said it), inferred (you deduced it), unknown.
4. Legal/financial content is SCOPING, not advice. State what to consider and what to ask a professional.
5. Score economy (cost efficiency), orchestration (operational complexity), demand (market pull).

CONSTELLATIONS (exactly 6):
- offer: What you're selling/providing
- demand: Who wants it and why
- delivery: How you fulfill it
- economy: Cost structure and unit economics
- orchestration: Ops, team, processes needed
- risk: What can break this`;

// Generate complete nebula from premise
async function generateNebula(premise, constraints = {}, maxRetries = 2) {
  const client = getClient();

  const constraintText = Object.keys(constraints).length > 0
    ? `\n\nCONSTRAINTS PROVIDED:\n${JSON.stringify(constraints, null, 2)}`
    : '\n\nNo constraints provided - generate honest uncertainty markers.';

  const userPrompt = `Decompose this business premise into a complete nebula:

PREMISE: "${premise}"${constraintText}

Return JSON with this structure:
{
  "core": { /* star schema for premise node, stage=0 */ },
  "constellations": [
    {
      "constellation": "offer",
      /* star schema fields */
      "children": [ /* 3-6 star nodes */ ]
    },
    /* repeat for: demand, delivery, economy, orchestration, risk */
  ]
}

Remember: If something is unknown, mark it as unknown with confidence.basis='unknown'. Don't fabricate.`;

  let lastError = null;
  let tokensUsed = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: NEBULA_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      });

      tokensUsed = response.usage?.input_tokens + response.usage?.output_tokens || 0;

      // Extract JSON from response
      const content = response.content[0]?.text || '';
      let nebula;

      try {
        // Try direct parse first
        nebula = JSON.parse(content);
      } catch {
        // Try to extract JSON from markdown code block
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          nebula = JSON.parse(jsonMatch[1].trim());
        } else {
          throw new Error('Response is not valid JSON');
        }
      }

      // Validate structure
      const errors = validateNebula(nebula);
      if (errors.length > 0) {
        if (attempt < maxRetries) {
          console.log(`[BlueprintLLM] Validation failed (attempt ${attempt + 1}), retrying:`, errors.slice(0, 3));
          continue;
        }
        throw new Error(`Schema validation failed: ${errors.slice(0, 5).join('; ')}`);
      }

      return { nebula, tokensUsed };

    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        console.log(`[BlueprintLLM] Attempt ${attempt + 1} failed:`, error.message);
        continue;
      }
    }
  }

  throw lastError || new Error('Failed to generate nebula');
}

// Expand a star into children
async function expandStar(node, context, maxRetries = 2) {
  const client = getClient();

  const userPrompt = `Expand this node into 3-6 actionable child stars:

PARENT NODE:
${JSON.stringify(node, null, 2)}

CONTEXT (other nodes in nebula):
${JSON.stringify(context.slice(0, 10), null, 2)}

Return JSON array of star nodes that break down the parent into actionable components.
Each child should be one step more concrete/actionable than the parent.
Inherit parent's stage unless the child clearly belongs to a different stage.

Return format:
{
  "children": [ /* array of star schema nodes */ ],
  "reasoning": "why these children decompose the parent"
}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: NEBULA_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const tokensUsed = response.usage?.input_tokens + response.usage?.output_tokens || 0;
      const content = response.content[0]?.text || '';

      let result;
      try {
        result = JSON.parse(content);
      } catch {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[1].trim());
        } else {
          throw new Error('Response is not valid JSON');
        }
      }

      if (!result.children || !Array.isArray(result.children)) {
        throw new Error('Missing children array');
      }

      // Validate each child
      const errors = [];
      for (let i = 0; i < result.children.length; i++) {
        errors.push(...validateStar(result.children[i], `child[${i}]`));
      }

      if (errors.length > 0 && attempt < maxRetries) {
        continue;
      }

      return { children: result.children, reasoning: result.reasoning, tokensUsed };

    } catch (error) {
      if (attempt >= maxRetries) throw error;
    }
  }
}

// Branch: create alternative path from node
async function branchNode(node, context) {
  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: NEBULA_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Create 2-3 alternative approaches to this node:

NODE:
${JSON.stringify(node, null, 2)}

Return format:
{
  "alternatives": [ /* array of star schema nodes representing different approaches */ ],
  "tradeoffs": "comparison of the alternatives"
}`
    }]
  });

  const content = response.content[0]?.text || '';
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[1].trim());
    }
  }

  return {
    alternatives: result?.alternatives || [],
    tradeoffs: result?.tradeoffs || '',
    tokensUsed: response.usage?.input_tokens + response.usage?.output_tokens || 0
  };
}

// Stress test a node
async function stressNode(node, context) {
  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: NEBULA_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Argue against this node. What breaks it? What are the failure modes?

NODE:
${JSON.stringify(node, null, 2)}

DEPENDENT NODES:
${JSON.stringify(context.filter(n => n.dependencies?.includes(node.id)), null, 2)}

Return format:
{
  "weaknesses": [
    { "point": "what breaks", "severity": 1-10, "mitigation": "how to address" }
  ],
  "dependencyRisks": [ /* what fails if this fails */ ],
  "commonFailureModes": [ /* industry patterns */ ],
  "updatedScores": { /* revised scores if stress changes assessment */ }
}`
    }]
  });

  const content = response.content[0]?.text || '';
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[1].trim());
    }
  }

  return {
    weaknesses: result?.weaknesses || [],
    dependencyRisks: result?.dependencyRisks || [],
    commonFailureModes: result?.commonFailureModes || [],
    updatedScores: result?.updatedScores || null,
    tokensUsed: response.usage?.input_tokens + response.usage?.output_tokens || 0
  };
}

// Cost estimation
async function costNode(node, context) {
  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: NEBULA_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Estimate cost and time for this node:

NODE:
${JSON.stringify(node, null, 2)}

Return format:
{
  "cost": {
    "capitalLow": number,
    "capitalHigh": number,
    "timeLow": number (days),
    "timeHigh": number (days),
    "basis": "detailed explanation of how you arrived at these numbers"
  },
  "assumptions": [ /* what you're assuming */ ],
  "variables": [ /* what could change the estimate significantly */ ]
}

CRITICAL: If you cannot estimate, return null values with basis explaining why. Never fabricate numbers.`
    }]
  });

  const content = response.content[0]?.text || '';
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[1].trim());
    }
  }

  return {
    cost: result?.cost || { capitalLow: null, capitalHigh: null, timeLow: null, timeHigh: null, basis: 'unknown' },
    assumptions: result?.assumptions || [],
    variables: result?.variables || [],
    tokensUsed: response.usage?.input_tokens + response.usage?.output_tokens || 0
  };
}

// Sequence: dependency-ordered execution list
async function sequenceNebula(nodes, edges) {
  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: NEBULA_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Given these nodes and their dependencies, return a dependency-ordered execution sequence:

NODES:
${JSON.stringify(nodes.map(n => ({ id: n.id, statement: n.statement, stage: n.stage, dependencies: n.dependencies })), null, 2)}

EDGES:
${JSON.stringify(edges, null, 2)}

Return format:
{
  "sequence": [
    { "nodeId": "...", "phase": 1, "parallelWith": [], "blockedBy": [], "rationale": "why here" }
  ],
  "criticalPath": [ /* nodeIds on the critical path */ ],
  "parallelTracks": [ /* groups that can run simultaneously */ ]
}`
    }]
  });

  const content = response.content[0]?.text || '';
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[1].trim());
    }
  }

  return {
    sequence: result?.sequence || [],
    criticalPath: result?.criticalPath || [],
    parallelTracks: result?.parallelTracks || [],
    tokensUsed: response.usage?.input_tokens + response.usage?.output_tokens || 0
  };
}

module.exports = {
  generateNebula,
  expandStar,
  branchNode,
  stressNode,
  costNode,
  sequenceNebula,
  validateStar,
  validateNebula,
  STAGE_NAMES,
  STAR_SCHEMA
};
