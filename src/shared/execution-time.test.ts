import { expect, it } from 'vitest'
import { formatExecutionTime } from './execution-time'

it('formats execution durations across hours and clamps negative clock differences', () => {
  expect([0, -1000, 65_000, 3_661_000, 90_061_000].map(formatExecutionTime))
    .toEqual(['00:00', '00:00', '01:05', '01:01:01', '25:01:01'])
})
