import { deliveryGuidance } from '../core/capability-diagnostics.mjs';

export function withDeliveryGuidance(assembly) {
  const name = 'dsh-collab.delivery-policy';
  return { ...assembly, contexts: [
    ...(assembly.contexts || []).filter(context => context.name !== name),
    { name, interpolate: false, text: deliveryGuidance(assembly.tools.map(tool => tool.name)) },
  ] };
}
