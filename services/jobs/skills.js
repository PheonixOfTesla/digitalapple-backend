/**
 * The skill taxonomy — canonical name to the ways people actually write it.
 *
 * Aliases matter more than the list length. A resume says "Node", a job
 * description says "Node.js", and a matcher that treats those as different
 * things reports a gap that does not exist and sends you to study something
 * you already know. Every alias here is a spelling seen in real postings.
 *
 * Grouped, because the groups are what a role archetype is actually made of:
 * "Senior Backend Engineer" is a shape in this space, not a job title.
 */
const SKILLS = {
  // languages
  javascript: ['javascript', 'js', 'es6', 'ecmascript'],
  typescript: ['typescript', 'ts'],
  python: ['python', 'python3', 'py'],
  java: ['java'],
  go: ['golang', 'go lang', ' go '],
  ruby: ['ruby'],
  php: ['php'],
  csharp: ['c#', 'csharp', '.net', 'dotnet'],
  cpp: ['c++', 'cpp'],
  rust: ['rust'],
  swift: ['swift'],
  kotlin: ['kotlin'],
  scala: ['scala'],
  elixir: ['elixir'],
  sql: ['sql'],

  // frontend
  react: ['react', 'reactjs', 'react.js'],
  nextjs: ['next.js', 'nextjs', 'next js'],
  vue: ['vue', 'vuejs', 'vue.js'],
  angular: ['angular', 'angularjs'],
  svelte: ['svelte', 'sveltekit'],
  html: ['html', 'html5'],
  css: ['css', 'css3', 'scss', 'sass', 'less'],
  tailwind: ['tailwind', 'tailwindcss'],
  redux: ['redux'],
  reactnative: ['react native', 'react-native'],

  // backend / runtime
  node: ['node', 'node.js', 'nodejs'],
  express: ['express', 'express.js', 'expressjs'],
  django: ['django'],
  flask: ['flask'],
  fastapi: ['fastapi'],
  rails: ['rails', 'ruby on rails'],
  spring: ['spring', 'spring boot', 'springboot'],
  laravel: ['laravel'],
  graphql: ['graphql'],
  rest: ['rest', 'rest api', 'restful'],
  grpc: ['grpc'],
  websockets: ['websocket', 'websockets', 'socket.io', 'socketio'],
  microservices: ['microservice', 'microservices'],

  // data
  postgres: ['postgres', 'postgresql', 'psql'],
  mysql: ['mysql', 'mariadb'],
  mongodb: ['mongodb', 'mongo', 'mongoose'],
  redis: ['redis'],
  elasticsearch: ['elasticsearch', 'elastic search', 'opensearch'],
  dynamodb: ['dynamodb'],
  kafka: ['kafka'],
  snowflake: ['snowflake'],
  bigquery: ['bigquery'],
  spark: ['spark', 'pyspark'],
  airflow: ['airflow'],

  // infra
  aws: ['aws', 'amazon web services', 'ec2', 's3', 'lambda'],
  gcp: ['gcp', 'google cloud'],
  azure: ['azure'],
  docker: ['docker'],
  kubernetes: ['kubernetes', 'k8s'],
  terraform: ['terraform'],
  cicd: ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery'],
  github_actions: ['github actions'],
  jenkins: ['jenkins'],
  nginx: ['nginx'],
  serverless: ['serverless'],
  linux: ['linux', 'unix'],

  // practice
  git: ['git', 'github', 'gitlab', 'version control'],
  testing: ['jest', 'pytest', 'unit test', 'unit testing', 'integration test', 'cypress', 'playwright', 'selenium', 'vitest'],
  agile: ['agile', 'scrum', 'kanban'],
  observability: ['datadog', 'sentry', 'prometheus', 'grafana', 'observability', 'opentelemetry'],
  security: ['oauth', 'jwt', 'authentication', 'authorization', 'owasp'],
  payments: ['stripe', 'payments', 'paypal', 'braintree', 'billing'],
  ml: ['machine learning', 'pytorch', 'tensorflow', 'llm', 'openai', 'rag', 'embeddings'],
  mobile: ['ios', 'android', 'flutter', 'expo'],
  design: ['figma', 'ui/ux', 'accessibility', 'wcag', 'responsive design']
};

const GROUPS = {
  language: ['javascript', 'typescript', 'python', 'java', 'go', 'ruby', 'php', 'csharp', 'cpp', 'rust', 'swift', 'kotlin', 'scala', 'elixir', 'sql'],
  frontend: ['react', 'nextjs', 'vue', 'angular', 'svelte', 'html', 'css', 'tailwind', 'redux', 'reactnative'],
  backend: ['node', 'express', 'django', 'flask', 'fastapi', 'rails', 'spring', 'laravel', 'graphql', 'rest', 'grpc', 'websockets', 'microservices'],
  data: ['postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'kafka', 'snowflake', 'bigquery', 'spark', 'airflow'],
  infra: ['aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'cicd', 'github_actions', 'jenkins', 'nginx', 'serverless', 'linux'],
  practice: ['git', 'testing', 'agile', 'observability', 'security', 'payments', 'ml', 'mobile', 'design']
};

const _groupIndex = {};
for (const [group, names] of Object.entries(GROUPS)) for (const n of names) _groupIndex[n] = group;

function groupOf(skill) { return _groupIndex[skill] || 'other'; }

/** Skills named in a job description, so a posting and a resume are comparable. */
function skillsInText(text) {
  const hay = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9+#./ -]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const out = [];
  for (const [canonical, aliases] of Object.entries(SKILLS)) {
    for (const alias of aliases) {
      if (hay.includes(' ' + alias.toLowerCase() + ' ')) { out.push(canonical); break; }
    }
  }
  return out;
}

module.exports = { SKILLS, GROUPS, groupOf, skillsInText };
