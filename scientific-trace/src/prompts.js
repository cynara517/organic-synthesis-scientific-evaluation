export function describeTools(tools) {
  const types = {string: 'str', integer: 'int', number: 'float', boolean: 'bool', array: 'list', object: 'dict'};
  return tools.map(t => {
    const required = new Set(t.parameters?.required ?? []);
    const template = {};
    const signature = Object.entries(t.parameters?.properties ?? {}).map(([name, schema]) => {
      const type = types[schema.type] ?? 'str';
      if (required.has(name)) template[name] = `<${type}>`;
      return `${name}${required.has(name) ? '' : '?'}: ${type}`;
    }).join(', ');
    // Match the original Python formatter, including spaces inside JSON objects.
    const json = JSON.stringify(template).replaceAll('":"', '": "').replaceAll('","', '", "');
    return `- **${t.name}**(${signature}): ${t.description}\n  call_params template: ${json}`;
  }).join('\n');
}

export function fillTemplate(template, values) {
  // Python str.format compatibility, without interpreting braces in inserted data.
  return template.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (match, key) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    if (!(key in values)) throw new Error(`Missing prompt variable: ${key}`);
    return String(values[key]);
  });
}

export const defaultPrompts = {
  experience: `You are the planning stage of a scientific agent. Return one JSON object.
TASK INSTRUCTION\n{instruction}
AVAILABLE TOOLS\n{tool_descriptions}
REFERENCE CASES\n{cases_content}
Use these fields: task_understanding, reference_cases_used (array of case IDs),
information_extracted, initial_plan (string), case_influence.
Describe an evidence-based plan. Do not invent observations or results.`,
  planning: `You are executing a scientific task one tool step at a time. Return one JSON object.
TASK INSTRUCTION\n{instruction}
INITIAL PLAN\n{initial_plan}
AVAILABLE TOOLS\n{tool_descriptions}
CURRENT STEP\nStep {step_number} of at most {max_steps}.
RECENT OBSERVATIONS\n{previous_observations}
If work remains, use current_objective, current_understanding, next_plan,
planning_rationale, plan_adjustment, selected_tool, selection_reasoning,
alternative_considered, call_params (object with actual arguments).
Ground understanding in observations. After completing and validating the task,
return current_objective, current_understanding, planning_rationale, final_answer.
Preserve task-specific output contracts. A formatted trace alone is not evidence
that the answer is correct.`
};
