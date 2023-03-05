import { Entity, Schema } from 'redis-om'
class Session extends Entity {}

export const sessionSchema = new Schema(
    Session,
    {
        data: { type: 'string' }
    }
)
