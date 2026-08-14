import { z } from 'zod'
import { NOTIFICATION_CATEGORIES } from '../../notifications'

const ChannelToggleSchema = z.object({
  email: z.boolean(),
  slack: z.boolean(),
})

export const NotificationPrefsSchema = z.object({
  channels: z.record(
    z.enum(NOTIFICATION_CATEGORIES),
    ChannelToggleSchema,
  ),
  timezone: z.string().nullable(),
  quiet_hours: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .nullable(),
  digest: z.object({
    enabled: z.boolean(),
    at: z.string(),
  }),
})
