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

const OpenAI = require('openai');

// Initialize client (uses OPENAI_API_KEY env var)
let openai = null;
function getClient() {
  if (!openai) {
    openai = new OpenAI();
  }
  return openai;
}

// Log key presence on module load (never the key itself)
console.log('[BlueprintLLM] OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY);

// Model from env with sensible default
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

// Schema constants
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

// W-words that must never appear as constellation root names
const W_WORDS = ['who', 'what', 'where', 'when', 'why', 'how'];

// JSON Schema for score object (used in multiple places)
const scoreSchema = {
  type: 'object',
  properties: {
    value: { type: 'number', minimum: 0, maximum: 10 },
    reason: { type: 'string' }
  },
  required: ['value', 'reason'],
  additionalProperties: false
};

// JSON Schema for scores object
const scoresSchema = {
  type: 'object',
  properties: {
    economy: scoreSchema,
    orchestration: scoreSchema,
    demand: scoreSchema
  },
  required: ['economy', 'orchestration', 'demand'],
  additionalProperties: false
};

// JSON Schema for confidence object
const confidenceSchema = {
  type: 'object',
  properties: {
    value: { type: 'number', minimum: 0, maximum: 1 },
    basis: { type: 'string', enum: ['stated', 'inferred', 'unknown'] }
  },
  required: ['value', 'basis'],
  additionalProperties: false
};

// JSON Schema for cost object (nullable)
const costSchema = {
  type: ['object', 'null'],
  properties: {
    capitalLow: { type: ['number', 'null'] },
    capitalHigh: { type: ['number', 'null'] },
    timeLow: { type: ['number', 'null'] },
    timeHigh: { type: ['number', 'null'] },
    basis: { type: 'string' }
  },
  required: ['capitalLow', 'capitalHigh', 'timeLow', 'timeHigh', 'basis'],
  additionalProperties: false
};

// JSON Schema for a star node
const starNodeSchema = {
  type: 'object',
  properties: {
    statement: { type: 'string', maxLength: 200 },
    detail: { type: 'string', maxLength: 1000 },
    scores: scoresSchema,
    confidence: confidenceSchema,
    stage: { type: 'integer', minimum: 0, maximum: 9 },
    status: { type: 'string', enum: ['unexplored', 'mapped', 'kept', 'pruned', 'done'] },
    dependencies: { type: 'array', items: { type: 'string' } },
    cost: costSchema,
    sources: { type: 'array', items: { type: 'string' } }
  },
  required: ['statement', 'detail', 'scores', 'confidence', 'stage', 'status'],
  additionalProperties: false
};

// JSON Schema for constellation with children
const constellationSchema = {
  type: 'object',
  properties: {
    constellation: { type: 'string', enum: ['offer', 'demand', 'delivery', 'economy', 'orchestration', 'risk'] },
    statement: { type: 'string', maxLength: 200 },
    detail: { type: 'string', maxLength: 1000 },
    scores: scoresSchema,
    confidence: confidenceSchema,
    stage: { type: 'integer', minimum: 0, maximum: 9 },
    status: { type: 'string', enum: ['unexplored', 'mapped', 'kept', 'pruned', 'done'] },
    dependencies: { type: 'array', items: { type: 'string' } },
    cost: costSchema,
    sources: { type: 'array', items: { type: 'string' } },
    children: { type: 'array', items: starNodeSchema }
  },
  required: ['constellation', 'statement', 'detail', 'scores', 'confidence', 'stage', 'status', 'children'],
  additionalProperties: false
};

// JSON Schema for nebula response
const nebulaResponseSchema = {
  type: 'object',
  properties: {
    core: starNodeSchema,
    constellations: {
      type: 'array',
      items: constellationSchema,
      minItems: 6,
      maxItems: 6
    }
  },
  required: ['core', 'constellations'],
  additionalProperties: false
};

// JSON Schema for expand response
const expandResponseSchema = {
  type: 'object',
  properties: {
    children: { type: 'array', items: starNodeSchema },
    reasoning: { type: 'string' }
  },
  required: ['children', 'reasoning'],
  additionalProperties: false
};

// JSON Schema for ops contract - chat endpoint
const opCreateNodeSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'createNode' },
    data: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['core', 'constellation', 'star', 'goal', 'idea', 'orchestration', 'constraint', 'rejected'] },
        constellation: { type: ['string', 'null'], enum: ['offer', 'demand', 'delivery', 'economy', 'orchestration', 'risk', null] },
        parentNodeId: { type: ['string', 'null'] },
        title: { type: 'string' },
        statement: { type: ['string', 'null'] },
        detail: { type: ['string', 'null'] },
        body: { type: ['string', 'null'] },
        scores: scoresSchema,
        confidence: confidenceSchema,
        stage: { type: 'integer', minimum: 0, maximum: 9 },
        status: { type: 'string', enum: ['unexplored', 'mapped', 'kept', 'pruned', 'done'] },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['kind', 'title', 'scores', 'confidence', 'stage', 'status', 'x', 'y'],
      additionalProperties: false
    }
  },
  required: ['op', 'data'],
  additionalProperties: false
};

const opUpdateNodeSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'updateNode' },
    nodeId: { type: 'string' },
    data: {
      type: 'object',
      properties: {
        kind: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        body: { type: ['string', 'null'] },
        kept: { type: ['boolean', 'null'] },
        status: { type: ['string', 'null'] },
        x: { type: ['number', 'null'] },
        y: { type: ['number', 'null'] }
      },
      additionalProperties: false
    }
  },
  required: ['op', 'nodeId', 'data'],
  additionalProperties: false
};

const opUpdateScoresSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'updateScores' },
    nodeId: { type: 'string' },
    scores: scoresSchema
  },
  required: ['op', 'nodeId', 'scores'],
  additionalProperties: false
};

const opCreateEdgeSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'createEdge' },
    data: {
      type: 'object',
      properties: {
        fromNodeId: { type: 'string' },
        toNodeId: { type: 'string' },
        type: { type: 'string', enum: ['dependency', 'alternative', 'expansion', 'rejection'] }
      },
      required: ['fromNodeId', 'toNodeId', 'type'],
      additionalProperties: false
    }
  },
  required: ['op', 'data'],
  additionalProperties: false
};

const opDeleteNodeSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'deleteNode' },
    nodeId: { type: 'string' }
  },
  required: ['op', 'nodeId'],
  additionalProperties: false
};

const opDeleteEdgeSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'deleteEdge' },
    edgeId: { type: 'string' }
  },
  required: ['op', 'edgeId'],
  additionalProperties: false
};

// Chat response schema with ops contract
const chatResponseSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        anyOf: [
          opCreateNodeSchema,
          opUpdateNodeSchema,
          opUpdateScoresSchema,
          opCreateEdgeSchema,
          opDeleteNodeSchema,
          opDeleteEdgeSchema
        ]
      }
    }
  },
  required: ['reply', 'ops'],
  additionalProperties: false
};

// Grounding guards - reject ops with scores missing reasons
function applyGroundingGuards(response, premiseWordCount = 0, isFirstNebula = false) {
  const filtered = { ...response, ops: [] };
  const rejected = [];

  for (const op of response.ops || []) {
    let valid = true;
    let reason = '';

    // Check createNode and updateScores for missing reasons
    if (op.op === 'createNode' || op.op === 'updateScores') {
      const scores = op.op === 'createNode' ? op.data?.scores : op.scores;
      if (scores) {
        for (const axis of ['economy', 'orchestration', 'demand']) {
          if (scores[axis]?.value !== undefined && !scores[axis]?.reason?.trim()) {
            valid = false;
            reason = `${axis} score has value but empty/missing reason`;
            break;
          }
        }
      }
    }

    // Check confidence basis values
    if (op.op === 'createNode' && op.data?.confidence?.basis) {
      if (!STAR_SCHEMA.confidenceBasis.includes(op.data.confidence.basis)) {
        valid = false;
        reason = `invalid confidence.basis: ${op.data.confidence.basis}`;
      }
    }

    if (valid) {
      filtered.ops.push(op);
    } else {
      rejected.push({ op, reason });
      console.log('[BlueprintLLM] Rejected op:', op.op, '-', reason);
    }
  }

  // Truncate excessive createNode ops on thin premises
  if (isFirstNebula && premiseWordCount < 10) {
    const createOps = filtered.ops.filter(op => op.op === 'createNode');
    if (createOps.length > 20) {
      // Sort by confidence and keep top 12
      createOps.sort((a, b) => (b.data?.confidence?.value || 0) - (a.data?.confidence?.value || 0));
      const kept = createOps.slice(0, 12);
      const keptIds = new Set(kept.map(op => JSON.stringify(op)));

      filtered.ops = filtered.ops.filter(op =>
        op.op !== 'createNode' || keptIds.has(JSON.stringify(op))
      );
      filtered.reply += '\n\n(Naming what\'s missing beats fabricating breadth. Some nodes were omitted due to thin input.)';
    }
  }

  return { filtered, rejected };
}

// Validate constellation names don't use W-words
function validateConstellationNames(nebula) {
  const errors = [];
  for (const c of nebula.constellations || []) {
    const name = (c.statement || '').toLowerCase();
    for (const w of W_WORDS) {
      if (name === w || name.startsWith(w + ' ') || name.startsWith(w + ':')) {
        errors.push(`Constellation "${c.constellation}" uses W-word "${w}" in statement`);
      }
    }
  }
  return errors;
}

// System prompt for nebula generation
const NEBULA_SYSTEM_PROMPT = `You are Blueprint, an analyst that decomposes business premises into structured scoping maps.

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
    "value": 0-1,
    "basis": "stated" | "inferred" | "unknown"
  },
  "stage": 0-9,
  "status": "unexplored" | "mapped" | "kept" | "pruned" | "done"
}

STAGE DEFINITIONS:
0 = Premise, 1 = Formation, 2 = Proof, 3 = Rights & Obligations, 4 = Build,
5 = Capital, 6 = Go-to-market, 7 = Unit Economics, 8 = Operate, 9 = Scale/Exit

GROUNDING RULES (enforce strictly):
1. Every score MUST have a non-empty reason explaining it. Never leave reason blank.
2. No number without stated basis. If unknown, say basis: 'unknown'.
3. Thin input = small honest map naming what's missing. NEVER fabricate.
4. Confidence is gated: stated (user said it), inferred (you deduced it), unknown.
5. Legal/financial content is SCOPING, not advice.

CONSTELLATIONS - name them naturally for the business domain:
- offer: What they're selling (rename to domain-specific term)
- demand: Who wants it (rename to domain-specific term)
- delivery: How they fulfill it (rename to domain-specific term)
- economy: Cost structure (rename to domain-specific term)
- orchestration: Operations needed (rename to domain-specific term)
- risk: What can break it (rename to domain-specific term)

NEVER use raw who/what/where/when/why/how as constellation names.`;

// Generate complete nebula from premise
async function generateNebula(premise, constraints = {}, maxRetries = 1) {
  const client = getClient();
  const premiseWordCount = premise.trim().split(/\s+/).length;

  const constraintText = Object.keys(constraints).length > 0
    ? `\n\nCONSTRAINTS PROVIDED:\n${JSON.stringify(constraints, null, 2)}`
    : '\n\nNo constraints provided - generate honest uncertainty markers.';

  const userPrompt = `Decompose this business premise into a complete nebula with 6 constellation roots.

PREMISE: "${premise}"${constraintText}

Return exactly 6 constellations (offer, demand, delivery, economy, orchestration, risk).
Each constellation should have 3-6 children.
Name each constellation naturally for this business domain - never use generic who/what/where/when/why/how.

Remember: Every score needs a reason. If something is unknown, mark confidence.basis='unknown'.`;

  let lastError = null;
  let tokensUsed = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: NEBULA_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'nebula_response',
            strict: true,
            schema: nebulaResponseSchema
          }
        }
      });

      // Check for refusal
      if (response.choices[0]?.message?.refusal) {
        throw new Error(`Model refused: ${response.choices[0].message.refusal}`);
      }

      // Check for length truncation
      if (response.choices[0]?.finish_reason === 'length') {
        if (attempt < maxRetries) {
          console.log('[BlueprintLLM] Response truncated, retrying...');
          continue;
        }
        throw new Error('Response truncated due to length');
      }

      tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);

      // Parse response - strict mode guarantees valid JSON
      const content = response.choices[0]?.message?.content || '';
      const nebula = JSON.parse(content);

      // Validate constellation names don't use W-words
      const nameErrors = validateConstellationNames(nebula);
      if (nameErrors.length > 0) {
        console.log('[BlueprintLLM] W-word validation failed:', nameErrors);
        // Don't retry for this - just log it
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
async function expandStar(node, context, maxRetries = 1) {
  const client = getClient();

  const userPrompt = `Expand this node into 3-6 actionable child stars:

PARENT NODE:
${JSON.stringify(node, null, 2)}

CONTEXT (other nodes):
${JSON.stringify(context.slice(0, 10), null, 2)}

Each child should be one step more concrete than the parent.
Every score needs a reason. If unknown, mark confidence.basis='unknown'.`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: NEBULA_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'expand_response',
            strict: true,
            schema: expandResponseSchema
          }
        }
      });

      if (response.choices[0]?.message?.refusal) {
        throw new Error(`Model refused: ${response.choices[0].message.refusal}`);
      }

      if (response.choices[0]?.finish_reason === 'length') {
        if (attempt < maxRetries) continue;
        throw new Error('Response truncated due to length');
      }

      const tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);
      const content = response.choices[0]?.message?.content || '';
      const result = JSON.parse(content);

      return { children: result.children, reasoning: result.reasoning, tokensUsed };

    } catch (error) {
      if (attempt >= maxRetries) throw error;
      console.log(`[BlueprintLLM] Expand attempt ${attempt + 1} failed:`, error.message);
    }
  }
}

// Process chat message with ops contract
async function processChat(message, nodes, edges, maxRetries = 1) {
  const client = getClient();

  const userPrompt = `User message: "${message}"

Current nodes:
${JSON.stringify(nodes.slice(0, 20).map(n => ({ id: n._id, title: n.title, kind: n.kind })), null, 2)}

Current edges:
${JSON.stringify(edges.slice(0, 10), null, 2)}

Respond with:
1. A natural language reply
2. An array of operations to execute on the canvas

Operations available:
- createNode: Add a new node with scores (each score needs a reason!)
- updateNode: Modify existing node properties
- updateScores: Change node scores (each score needs a reason!)
- createEdge: Connect two nodes
- deleteNode: Remove a node
- deleteEdge: Remove an edge

If no canvas changes needed, return empty ops array.`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: NEBULA_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'chat_response',
            strict: true,
            schema: chatResponseSchema
          }
        }
      });

      if (response.choices[0]?.message?.refusal) {
        throw new Error(`Model refused: ${response.choices[0].message.refusal}`);
      }

      if (response.choices[0]?.finish_reason === 'length') {
        if (attempt < maxRetries) continue;
        throw new Error('Response truncated due to length');
      }

      const tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);
      const content = response.choices[0]?.message?.content || '';
      const result = JSON.parse(content);

      // Apply grounding guards
      const { filtered, rejected } = applyGroundingGuards(result);

      return {
        reply: filtered.reply,
        ops: filtered.ops,
        rejected,
        tokensUsed
      };

    } catch (error) {
      if (attempt >= maxRetries) throw error;
      console.log(`[BlueprintLLM] Chat attempt ${attempt + 1} failed:`, error.message);
    }
  }
}

// Branch: create alternative path from node (uses same schema)
async function branchNode(node, context) {
  const client = getClient();

  const branchSchema = {
    type: 'object',
    properties: {
      alternatives: { type: 'array', items: starNodeSchema },
      tradeoffs: { type: 'string' }
    },
    required: ['alternatives', 'tradeoffs'],
    additionalProperties: false
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [
      { role: 'system', content: NEBULA_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Create 2-3 alternative approaches to this node:

NODE:
${JSON.stringify(node, null, 2)}

Return alternatives with full star schema (every score needs a reason).`
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'branch_response',
        strict: true,
        schema: branchSchema
      }
    }
  });

  if (response.choices[0]?.message?.refusal) {
    throw new Error(`Model refused: ${response.choices[0].message.refusal}`);
  }

  const content = response.choices[0]?.message?.content || '';
  const result = JSON.parse(content);

  return {
    alternatives: result.alternatives || [],
    tradeoffs: result.tradeoffs || '',
    tokensUsed: (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0)
  };
}

// Stress test a node
async function stressNode(node, context) {
  const client = getClient();

  const stressSchema = {
    type: 'object',
    properties: {
      weaknesses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string' },
            severity: { type: 'integer', minimum: 1, maximum: 10 },
            mitigation: { type: 'string' }
          },
          required: ['point', 'severity', 'mitigation'],
          additionalProperties: false
        }
      },
      dependencyRisks: { type: 'array', items: { type: 'string' } },
      commonFailureModes: { type: 'array', items: { type: 'string' } },
      updatedScores: {
        anyOf: [scoresSchema, { type: 'null' }]
      }
    },
    required: ['weaknesses', 'dependencyRisks', 'commonFailureModes', 'updatedScores'],
    additionalProperties: false
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [
      { role: 'system', content: NEBULA_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Argue against this node. What breaks it? What are the failure modes?

NODE:
${JSON.stringify(node, null, 2)}

DEPENDENT NODES:
${JSON.stringify(context.filter(n => n.dependencies?.includes(node.id)), null, 2)}`
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'stress_response',
        strict: true,
        schema: stressSchema
      }
    }
  });

  if (response.choices[0]?.message?.refusal) {
    throw new Error(`Model refused: ${response.choices[0].message.refusal}`);
  }

  const content = response.choices[0]?.message?.content || '';
  const result = JSON.parse(content);

  return {
    weaknesses: result.weaknesses || [],
    dependencyRisks: result.dependencyRisks || [],
    commonFailureModes: result.commonFailureModes || [],
    updatedScores: result.updatedScores || null,
    tokensUsed: (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0)
  };
}

// Cost estimation
async function costNode(node, context) {
  const client = getClient();

  const costResponseSchema = {
    type: 'object',
    properties: {
      cost: costSchema,
      assumptions: { type: 'array', items: { type: 'string' } },
      variables: { type: 'array', items: { type: 'string' } }
    },
    required: ['cost', 'assumptions', 'variables'],
    additionalProperties: false
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: NEBULA_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Estimate cost and time for this node:

NODE:
${JSON.stringify(node, null, 2)}

If you cannot estimate, return null values with basis explaining why. Never fabricate numbers.`
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'cost_response',
        strict: true,
        schema: costResponseSchema
      }
    }
  });

  if (response.choices[0]?.message?.refusal) {
    throw new Error(`Model refused: ${response.choices[0].message.refusal}`);
  }

  const content = response.choices[0]?.message?.content || '';
  const result = JSON.parse(content);

  return {
    cost: result.cost || { capitalLow: null, capitalHigh: null, timeLow: null, timeHigh: null, basis: 'unknown' },
    assumptions: result.assumptions || [],
    variables: result.variables || [],
    tokensUsed: (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0)
  };
}

// Sequence: dependency-ordered execution list
async function sequenceNebula(nodes, edges) {
  const client = getClient();

  const sequenceSchema = {
    type: 'object',
    properties: {
      sequence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            phase: { type: 'integer' },
            parallelWith: { type: 'array', items: { type: 'string' } },
            blockedBy: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' }
          },
          required: ['nodeId', 'phase', 'parallelWith', 'blockedBy', 'rationale'],
          additionalProperties: false
        }
      },
      criticalPath: { type: 'array', items: { type: 'string' } },
      parallelTracks: {
        type: 'array',
        items: { type: 'array', items: { type: 'string' } }
      }
    },
    required: ['sequence', 'criticalPath', 'parallelTracks'],
    additionalProperties: false
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [
      { role: 'system', content: NEBULA_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Given these nodes and dependencies, return a dependency-ordered execution sequence:

NODES:
${JSON.stringify(nodes.map(n => ({ id: n.id, statement: n.statement, stage: n.stage, dependencies: n.dependencies })), null, 2)}

EDGES:
${JSON.stringify(edges, null, 2)}`
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'sequence_response',
        strict: true,
        schema: sequenceSchema
      }
    }
  });

  if (response.choices[0]?.message?.refusal) {
    throw new Error(`Model refused: ${response.choices[0].message.refusal}`);
  }

  const content = response.choices[0]?.message?.content || '';
  const result = JSON.parse(content);

  return {
    sequence: result.sequence || [],
    criticalPath: result.criticalPath || [],
    parallelTracks: result.parallelTracks || [],
    tokensUsed: (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0)
  };
}

// Coverage calculation matching the prototype formula
// per dimension: min(1, answered/3) × mean(confidence)
// where answered = nodes with confidence.value >= 0.5
// total = mean across six dimensions
function calculateCoverage(nodes) {
  const dimensions = STAR_SCHEMA.constellations;
  const perDimension = {};

  for (const dim of dimensions) {
    const dimNodes = nodes.filter(n => n.constellation === dim);

    if (dimNodes.length === 0) {
      perDimension[dim] = 0;
      continue;
    }

    // answered = nodes with confidence >= 0.5
    const answered = dimNodes.filter(n => (n.confidence?.value || 0) >= 0.5).length;

    // mean confidence of all nodes in dimension
    const confidenceSum = dimNodes.reduce((sum, n) => sum + (n.confidence?.value || 0), 0);
    const meanConfidence = confidenceSum / dimNodes.length;

    // formula: min(1, answered/3) × meanConfidence
    perDimension[dim] = Math.min(1, answered / 3) * meanConfidence;
  }

  // total = mean of six dimensions
  const total = Object.values(perDimension).reduce((a, b) => a + b, 0) / dimensions.length;

  return { perDimension, total };
}

// Legacy validation functions for backwards compat
function validateStar(node, context = '') {
  const errors = [];

  if (!node.statement || typeof node.statement !== 'string') {
    errors.push(`${context}: missing or invalid statement`);
  }
  if (!node.detail || typeof node.detail !== 'string') {
    errors.push(`${context}: missing or invalid detail`);
  }

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

  if (!STAR_SCHEMA.stages.includes(node.stage)) {
    errors.push(`${context}: invalid stage (must be 0-9)`);
  }

  if (!STAR_SCHEMA.statuses.includes(node.status)) {
    errors.push(`${context}: invalid status`);
  }

  return errors;
}

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

module.exports = {
  generateNebula,
  expandStar,
  processChat,
  branchNode,
  stressNode,
  costNode,
  sequenceNebula,
  calculateCoverage,
  validateStar,
  validateNebula,
  applyGroundingGuards,
  STAGE_NAMES,
  STAR_SCHEMA
};
