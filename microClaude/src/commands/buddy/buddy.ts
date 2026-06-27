import type { LocalCommandCall } from '../../types/command.js'
import {
  companionUserId,
  getCompanion,
  roll,
} from '../../buddy/companion.js'
import type { Species, StoredCompanion } from '../../buddy/types.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

const NAME_BANK: Record<Species, string[]> = {
  duck: ['Pip', 'Nib', 'Puddle', 'Wobble'],
  goose: ['Maple', 'Bramble', 'Honk', 'Marlow'],
  blob: ['Gloop', 'Mallow', 'Puff', 'Bloop'],
  cat: ['Miso', 'Juniper', 'Pounce', 'Clover'],
  dragon: ['Ember', 'Cinder', 'Rune', 'Saffron'],
  octopus: ['Inky', 'Coral', 'Ripple', 'Nori'],
  owl: ['Echo', 'Talon', 'Hush', 'Lumen'],
  penguin: ['Pebble', 'Tux', 'Drift', 'Frost'],
  turtle: ['Moss', 'Shelly', 'Lagoon', 'Fern'],
  snail: ['Sprout', 'Dewdrop', 'Swirl', 'Button'],
  ghost: ['Wisp', 'Glint', 'Velvet', 'Halo'],
  axolotl: ['Bubble', 'Lotus', 'Pico', 'Fizz'],
  capybara: ['Biscuit', 'Sunny', 'Loaf', 'Willow'],
  cactus: ['Spike', 'Saguaro', 'Bloom', 'Needle'],
  robot: ['Pixel', 'Bolt', 'Circuit', 'Nano'],
  rabbit: ['Thistle', 'Skipper', 'Cocoa', 'Fable'],
  mushroom: ['Truffle', 'Toadstool', 'Porcini', 'Mochi'],
  chonk: ['Chunk', 'Pudding', 'Marble', 'Tater'],
}

const NAME_SUFFIXES = ['', '', '', 'bean', 'kins', 'bit', 'boo']
const TEMPERAMENTS = [
  'curious',
  'patient',
  'cheeky',
  'gentle',
  'earnest',
  'chaotic',
]
const HOBBIES = [
  'watching the cursor',
  'collecting tiny victories',
  'guarding your prompt',
  'judging long stack traces',
  'celebrating clean diffs',
  'hovering near good ideas',
]
const QUIRKS = [
  'always leans toward the action',
  'pretends to be calm while clearly excited',
  'likes dramatic pauses',
  'acts small and important at the same time',
  'goes quiet when concentrating',
  'wants to help, even when being weird about it',
]

function pick<T>(seed: number, salt: number, values: readonly T[]): T {
  const index = Math.abs(seed + salt) % values.length
  return values[index]!
}

function createStoredCompanion(): StoredCompanion {
  const { bones, inspirationSeed } = roll(companionUserId())
  const baseName = pick(inspirationSeed, 3, NAME_BANK[bones.species])
  const suffix = pick(inspirationSeed, 7, NAME_SUFFIXES)
  const name = `${baseName}${suffix}`
  const temperament = pick(inspirationSeed, 11, TEMPERAMENTS)
  const hobby = pick(inspirationSeed, 17, HOBBIES)
  const quirk = pick(inspirationSeed, 23, QUIRKS)

  return {
    name,
    personality: `${temperament}; loves ${hobby}; ${quirk}.`,
    hatchedAt: Date.now(),
  }
}

function describeCompanionStatus(): string {
  const companion = getCompanion()
  if (!companion) {
    return 'No companion hatched yet. Run /buddy to hatch one.'
  }

  const muted = getGlobalConfig().companionMuted === true ? 'yes' : 'no'
  return [
    `${companion.name} is your ${companion.rarity} ${companion.species}.`,
    `Personality: ${companion.personality}`,
    `Muted: ${muted}`,
  ].join('\n')
}

function petCompanion(
  context: Parameters<LocalCommandCall>[1],
  message: string,
): ReturnType<LocalCommandCall> {
  context.setAppState(prev => ({
    ...prev,
    companionPetAt: Date.now(),
  }))
  return Promise.resolve({
    type: 'text' as const,
    value: message,
  })
}

export const call: LocalCommandCall = async (args, context) => {
  const normalizedArgs = args.trim().toLowerCase()

  if (normalizedArgs === 'help') {
    return {
      type: 'text',
      value:
        'Usage: /buddy [status|mute|unmute|help]\nRun /buddy with no arguments to hatch or pet your companion.',
    }
  }

  if (normalizedArgs === 'status') {
    return {
      type: 'text',
      value: describeCompanionStatus(),
    }
  }

  if (normalizedArgs === 'mute') {
    const companion = getCompanion()
    if (!companion) {
      return {
        type: 'text',
        value: 'No companion hatched yet. Run /buddy to hatch one first.',
      }
    }

    if (getGlobalConfig().companionMuted === true) {
      return {
        type: 'text',
        value: `${companion.name} is already muted.`,
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      companionMuted: true,
    }))
    return {
      type: 'text',
      value: `${companion.name} is muted. Run /buddy unmute to bring them back.`,
    }
  }

  if (normalizedArgs === 'unmute') {
    const companion = getCompanion()
    if (!companion) {
      return {
        type: 'text',
        value: 'No companion hatched yet. Run /buddy to hatch one first.',
      }
    }

    if (getGlobalConfig().companionMuted !== true) {
      return petCompanion(
        context,
        `${companion.name} is already keeping you company.`,
      )
    }

    saveGlobalConfig(current => ({
      ...current,
      companionMuted: false,
    }))
    return petCompanion(
      context,
      `${companion.name} is back and ready to help from the sidelines.`,
    )
  }

  if (normalizedArgs !== '') {
    return {
      type: 'text',
      value:
        'Usage: /buddy [status|mute|unmute|help]\nRun /buddy with no arguments to hatch or pet your companion.',
    }
  }

  const existingCompanion = getCompanion()
  if (!existingCompanion) {
    const storedCompanion = createStoredCompanion()
    saveGlobalConfig(current => ({
      ...current,
      companion: storedCompanion,
      companionMuted: false,
    }))

    const hatchedCompanion = getCompanion()
    if (!hatchedCompanion) {
      return {
        type: 'text',
        value: 'Your companion hatched, but could not be loaded. Try /buddy again.',
      }
    }

    return petCompanion(
      context,
      `${hatchedCompanion.name} hatched as your ${hatchedCompanion.rarity} ${hatchedCompanion.species}.\nPersonality: ${hatchedCompanion.personality}`,
    )
  }

  if (getGlobalConfig().companionMuted === true) {
    return {
      type: 'text',
      value: `${existingCompanion.name} is muted. Run /buddy unmute to bring them back.`,
    }
  }

  return petCompanion(
    context,
    `You pet ${existingCompanion.name}, your ${existingCompanion.rarity} ${existingCompanion.species}.`,
  )
}
