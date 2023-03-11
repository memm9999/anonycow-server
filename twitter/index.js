import got from "got";
import {PrismaClient} from "@prisma/client";
import {Client} from "twitter-api-sdk";
import pkg from 'lodash';

const {uniqWith, isEqual} = pkg;
const prisma = new PrismaClient();

export default class TwitterData {
    constructor(userId = null, userData = null, targets = []) {
        this.userId = userId
        this.userData = userData
        this.targets = targets
        this.paginateAllOver.bind(this)
    }

    store = async (job, done) => {

        console.log(`>>> Store job started for user: ${this.userId}`)

        console.log(`>>> >>> Grabbing follows started for user: ${this.userId}`)

        /*
        * Follows grabbing step
        * */

        let follows

        for await (
            const _ of TwitterData.asyncIterWithCallback(
            this.targets.concat([this.userId]),
            async (userId) => {
                const _uoc = {
                    id: userId,
                    ...(userId !== this.userId ? {
                        data: (await this.getUserData(userId))?.data
                    } : {
                        data: this.userData
                    }),
                    ...(userId === this.userId ? {
                        user: {
                            connect: {
                                id: userId
                            }
                        }
                    } : {})
                }

                await prisma.twitterUser.upsert({
                    where: {
                        id: userId
                    },
                    update: _uoc,
                    create: _uoc
                })

                if (userId === this.userId) {
                    follows = await this.storeFollows(userId)
                } else {
                    await this.storeFollows(userId)
                }

            }
        )) {
        }

        follows.unshift(this.targets)

        follows = uniqWith(follows.flat(), isEqual)

        console.log(`>>> >>> Grabbing follows is done for user: ${this.userId}`)

        console.log(`>>> >>> Grabbing conversations started for user: ${this.userId}`)

        /*
        * Conversations grabbing step
        * */

        // for (const participantId of (follows?.length > 0 ? follows : this.targets)) {
        //     // console.log(`>>> for target: ${participantId}`)
        //     await this.storeConversationMessages(`${participantId}-${this.userId}`)
        // }

        // for await (const participantId of TwitterData.asyncIterWithCallback(
        //     this.targets,
        //     async (participantId) => {
        //         console.log(`>>> for target: ${participantId}`)
        //         await this.storeConversation(`${participantId}-${this.userId}`)
        //     }
        // )) {}

        for await (const participantId of TwitterData.asyncIterWithCallback(
            (follows?.length > 0 ? follows : this.targets),
            async (participantId) => {
                console.log(`>>> >>> >>> for user: ${participantId}`)
                await this.storeConversation(`${participantId}-${this.userId}`, [participantId, this.userId])
            }
        )) {
        }

        console.log(`>>> >>> Grabbing conversations ended for user: ${this.userId}`)

        console.log(`>>> >>> Grabbing tweets started for user: ${this.userId} and TARGETS`)

        /*
        * Tweets grabbing step
        * */

        for await (
            const userId of TwitterData.asyncIterWithCallback(
            this.targets.concat([this.userId]),
            this.storeTweets
        )) {
        }

        console.log(`>>> >>> Grabbing tweets is done for user: ${this.userId} and TARGETS`)

        await prisma.user.update({
            where: {
                id: this.userId
            },
            data: {
                scripted: true
            }
        })

        console.log(`>>> Store job is done for user: ${this.userId}`)
        done()
    }

    storeFollows = async (userId) => {

        const operations = [
            {
                url: `https://api.twitter.com/2/users/${userId}/followers`,
                rel: (follow) => ({
                    followers: {
                        connectOrCreate: {
                            where: {
                                id: follow.id
                            },
                            create: {
                                id: follow.id,
                                data: follow
                            }
                        }
                    }
                })
            },
            {
                url: `https://api.twitter.com/2/users/${userId}/following`,
                rel: (follow) => ({
                    followings: {
                        connectOrCreate: {
                            where: {
                                id: follow.id
                            },
                            create: {
                                id: follow.id,
                                data: follow
                            }
                        }
                    }
                })
            }
        ]

        let follows = []

        for await (const _ of TwitterData.asyncIterWithCallback(
            operations,
            async ({url, rel}) => {
                for await (const {data} of this.paginateAllOver(
                    url,
                    {
                        'expansions': 'pinned_tweet_id',
                        'max_results': 100,
                        'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld',
                    }
                )) {
                    for (const follow of data) {
                        const _uoc = {
                            id: userId,
                            ...rel(follow)
                        }

                        await prisma.twitterUser.upsert({
                            where: {
                                id: userId
                            },
                            update: _uoc,
                            create: _uoc
                        })
                        follows.push(follow.id)
                    }
                }

                follows = uniqWith(follows, isEqual)
            }
        )) {
        }

        return follows
    }

    storeConversation = async (conversationId, participantsIds) => {
        let conversationStored;

        for await (const {data, includes} of this.paginateAllOver(
            `https://api.twitter.com/2/dm_conversations/${conversationId}/dm_events`,
            {
                'dm_event.fields': 'id,text,event_type,created_at,dm_conversation_id,sender_id,participant_ids,referenced_tweets,attachments',
                'event_types': 'MessageCreate,ParticipantsJoin,ParticipantsLeave',
                'expansions': 'attachments.media_keys,referenced_tweets.id,sender_id,participant_ids',
                'max_results': 100,
                'media.fields': 'duration_ms,height,media_key,preview_image_url,type,url,width,public_metrics,alt_text,variants',
                'tweet.fields': 'attachments,author_id,context_annotations,conversation_id,created_at,edit_controls,entities,geo,id,in_reply_to_user_id,lang,public_metrics,possibly_sensitive,referenced_tweets,reply_settings,source,text,withheld',
                'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld',
            }
        )) {
            const _includesDictionary = {
                "users": "user",
                "tweets": "tweet",
                "media": "media"
            }

            if (data) {

                /**
                 * Save conversation
                 * */

                if (!conversationStored) {
                    for(const participantId of participantsIds) {
                        const _uoc = {
                            id: participantId,
                            conversations: {
                                connectOrCreate: {
                                    where: {
                                        id: conversationId
                                    },
                                    create: {
                                        id: conversationId
                                    }
                                }
                            }
                        }
                        await prisma.twitterUser.upsert({
                            where: {
                                id: participantId
                            },
                            update: _uoc,
                            create: _uoc
                        })
                    }

                    conversationStored = true
                }

                /**
                 * Save messages
                 * */

                for (const {id, text, sender_id, event_type, created_at, dm_conversation_id} of data) {
                    const _uoc = {
                        id: id,
                        text: text,
                        senderId: sender_id,
                        eventType: event_type,
                        createdAt: created_at,
                        dmConversation: {
                            connect: {
                                id: dm_conversation_id
                            }
                        }
                    }

                    await prisma.twitterDM.upsert({
                        where: {
                            id: id
                        },
                        update: _uoc,
                        create: _uoc
                    })
                }

                /**
                 * Save includes
                 * */

                if (includes) {

                    for (const key in includes) {

                        for (const {id, media_key, ...data} of includes[key]) {

                            const _uoc = {
                                id: conversationId,
                                includes: {
                                    connectOrCreate: {
                                        where: {
                                            id: id || media_key
                                        },
                                        create: {
                                            id: id || media_key,
                                            type: _includesDictionary[key],
                                            data: data
                                        }
                                    }
                                }
                            }

                            await prisma.twitterDMConversation.upsert({
                                where: {
                                    id: conversationId
                                },
                                update: _uoc,
                                create: _uoc
                            })
                        }

                    }
                }
            }
        }

    }

    storeTweets = async (userId) => {
        const saveAuthorWithTweet = async ({id, text, created_at, author_id, ...tweet}) => {
            const _uoc = {
                id: author_id,
                tweets: {
                    connectOrCreate: {
                        where: {
                            id: id
                        },
                        create: {
                            id: id,
                            text: text,
                            createdAt: created_at,
                            data: tweet
                        }
                    }
                }
            }

            await prisma.twitterUser.upsert({
                where: {
                    id: author_id
                },
                update: _uoc,
                create: _uoc
            })
        }

        const operations = [
            {
                url: `https://api.twitter.com/2/users/${userId}/tweets`,
                callback: async (userId, tweet) => {
                    await saveAuthorWithTweet(tweet)
                }
            },
            {
                url: `https://api.twitter.com/2/users/${userId}/mentions`,
                callback: async (userId, tweet) => {
                    const _uoc = {
                        id: userId,
                        mentions: {
                            connect: {
                                id: tweet.id
                            }
                        }
                    }

                    await saveAuthorWithTweet(tweet)

                    await prisma.twitterUser.upsert({
                        where: {
                            id: userId
                        },
                        update: _uoc,
                        create: _uoc
                    })
                }
            },
            {
                url: `https://api.twitter.com/2/users/${userId}/liked_tweets`,
                callback: async (userId, tweet) => {
                    const _uoc = {
                        id: userId,
                        liked: {
                            connect: {
                                id: tweet.id
                            }
                        }
                    }

                    await saveAuthorWithTweet(tweet)

                    await prisma.twitterUser.upsert({
                        where: {
                            id: userId
                        },
                        update: _uoc,
                        create: _uoc
                    })
                }
            }
        ]

        const _includesDictionary = {
            "users": "user",
            "tweets": "tweet",
            "media": "media",
            "places": "place",
            "polls": "poll"
        }

        for await (const _ of TwitterData.asyncIterWithCallback(
            operations,
            async ({url, callback}) => {
                for await (const {data, includes} of this.paginateAllOver(
                    url,
                    {
                        "expansions": "attachments.poll_ids,attachments.media_keys,author_id,edit_history_tweet_ids,entities.mentions.username,geo.place_id,in_reply_to_user_id,referenced_tweets.id,referenced_tweets.id.author_id",
                        "max_results": 100,
                        "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width,public_metrics,alt_text,variants",
                        "place.fields": "contained_within,country,country_code,full_name,geo,id,name,place_type",
                        "poll.fields": "duration_minutes,end_datetime,id,options,voting_status",
                        "tweet.fields": "attachments,author_id,context_annotations,conversation_id,created_at,edit_controls,entities,geo,id,in_reply_to_user_id,lang,public_metrics,possibly_sensitive,referenced_tweets,reply_settings,source,text,withheld",
                        "user.fields": "created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,verified_type,withheld",
                    }
                )) {

                    if(data) {
                        for(const tweet of data) {
                            await callback(userId, tweet)
                        }
                    }

                    if(includes) {
                        for(const key in includes) {
                            for(const {id, media_key, ...data} of includes[key]) {
                                const _uoc = {
                                    id: id || media_key,
                                    type: _includesDictionary[key],
                                    data: data
                                }
                                await prisma.twitterDMInclude.upsert({
                                    where: {
                                        id: id || media_key
                                    },
                                    update: _uoc,
                                    create: _uoc
                                })
                            }
                        }
                    }

                }
            }
        )) {
        }


    }

    getAccessToken = async () => {
        const {accessToken} = await prisma.twitterToken.findFirst({
            where: {
                userId: this.userId
            },
            orderBy: {
                timestamp: "desc"
            }
        })

        return accessToken
    }

    getUserData = async (userId) => {
        const twitter = new Client(await this.getAccessToken())

        return await twitter.users.findUserById(
            userId,
            {
                'expansions': 'pinned_tweet_id',
                'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld',
            }
        )
    }

    static sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    static asyncIterWithCallback = async function* (iter, callback = async (item) => {}, counter = 0) {
        const item = iter[counter]

        yield item

        try {
            await callback(item)
        } catch (e) {
            console.log(e)
        }

        counter++

        if (counter < iter?.length) {
            for await (const item of TwitterData.asyncIterWithCallback(iter, callback, counter)) {
                yield item
            }
        } else {
            return null
        }
    }

    paginateAllOver = async function* (url, searchParams, callback = async () => {
    }, nextToken = true) {

        let _skip = false

        const response = await got.get(
            url,
            {
                searchParams: searchParams,
                headers: {
                    'Authorization': `Bearer ${await this.getAccessToken()}`
                }
            }
        ).catch(async ({response: {headers, statusCode}}) => {
            _skip = true
            if(statusCode === 429) {
                const remainingTime = (headers?.['x-rate-limit-reset']*1000) - Date.now()
                console.log(`>>> Waiting for a ${remainingTime}ms until rate limiting reset ...`)
                await TwitterData.sleep(remainingTime)
            }
        })

        if(!_skip) {
            const page = JSON.parse(response?.body || "{}")
            const { statusCode } = response

            if(statusCode === 200) {
                nextToken = page?.meta?.next_token
            }

            if (page?.data) {
                try {
                    await callback(page)
                } catch (e) {
                    console.log(e)
                }

                yield page
            }
        }

        if (!!nextToken) {
            for await (const page of this.paginateAllOver(url, {
                ...searchParams,
                ...(
                    nextToken === true ? {} : {
                        'pagination_token': nextToken
                    }
                )
            }, callback, nextToken)) {
                yield page
            }
        } else {
            return null
        }

    }

}