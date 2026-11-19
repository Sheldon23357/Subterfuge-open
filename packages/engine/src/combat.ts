import { integer } from './numeric.js';

export interface DrillerPhaseInput {
  attackerDrillers: number; defenderDrillers: number; shield: number;
  isOutpost: boolean;
}
/** Shields absorb damage first; equal forces leave an outpost with its defender. */
export function resolveDrillerPhase(input: DrillerPhaseInput) {
  for (const key of ['attackerDrillers','defenderDrillers','shield'] as const) integer(input[key], key);
  if (!input.isOutpost && input.shield !== 0) throw new RangeError('A sub cannot have shields');
  const attack = input.attackerDrillers, defense = input.defenderDrillers + input.shield;
  const winner: 'attacker' | 'defender' | 'draw' = attack > defense ? 'attacker' : attack < defense ? 'defender'
    : input.isOutpost ? 'defender' : 'draw';
  const attacker = Math.max(0, Math.min(input.attackerDrillers, attack - defense));
  const defender = Math.max(0, Math.min(input.defenderDrillers, defense - attack));
  return { attacker, defender, shield: Math.max(0, input.shield - attack), winner,
    attackerLoss: input.attackerDrillers - attacker, defenderLoss: input.defenderDrillers - defender };
}
