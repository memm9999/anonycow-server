import got from "got";
import {PrismaClient} from "@prisma/client";
import {Client} from "twitter-api-sdk";
import pkg from 'lodash';
import crypto from "crypto";
import querystring from "querystring";
import {TwitterOAuthClientBase} from "../index.js";

const {uniqWith, isEqual} = pkg;
const prisma = new PrismaClient();

export default class TwitterData2 {
    constructor(userId = null, userContextOrData = null, targets = []) {
        this.userId = userId
        if (userContextOrData instanceof TwitterOAuthClientBase) {
            this.userContext = userContextOrData
        } else {
            this.userData = userContextOrData
        }
        this.targets = targets
        this.paginateAllOver.bind(this)
    }

    store = async (job, done) => {

        if (!this.userData && this.userContext) {
            this.userData = await this.userContext.mev2
        }

        console.log(`>>> Store job started for user: ${this.userId}`)

        /*
        * Follows grabbing step
        * */

        console.log(`>>> >>> Grabbing follows started for user: ${this.userId}`)

        let follows

        for await (
            const _ of TwitterData2.asyncIterWithCallback(
            this.targets.concat([this.userId]),
            async (userId) => {
                const _uoc = {
                    id: userId,
                    data: ((userId !== this.userId) ? (await this.getUserData(userId)) : (this.userData))?.data,
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

        /*
        * Conversations grabbing step
        * */

        console.log(`>>> >>> Grabbing conversations started for user: ${this.userId}`)

        for await (const participantId of TwitterData2.asyncIterWithCallback(
            this.targets,
            async (participantId) => {
                console.log(`>>> for target: ${participantId}`)
                await this.storeConversation(`${participantId}-${this.userId}`)
            }
        )) {}

        for await (const participantId of TwitterData2.asyncIterWithCallback(
            (follows?.length > 0 ? follows : this.targets),
            async (participantId) => {
                if(participantId) {
                    console.log(`>>> >>> >>> for user: ${participantId}`)
                    await this.storeConversation([participantId, this.userId])
                }
            }
        )) {
        }

        console.log(`>>> >>> Grabbing conversations ended for user: ${this.userId}`)

        /*
        * Tweets grabbing step
        * */

        console.log(`>>> >>> Grabbing tweets started for user: ${this.userId} and TARGETS`)

        for await (
            const userId of TwitterData2.asyncIterWithCallback(
            this.targets.concat([this.userId]),
            this.storeTweets
        )) {
            console.log(`>>> >>> >>> for user: ${userId}`)
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
                }),
                refUpdate: (mostRecentFollowerId) => ({
                    mostRecentFollowerId: mostRecentFollowerId
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
                }),
                refUpdate: (mostRecentFollowingId) => ({
                    mostRecentFollowingId: mostRecentFollowingId
                })
            }
        ]

        let follows = []
        let _mostRecent = []

        for await (const _ of TwitterData2.asyncIterWithCallback(
            operations,
            async ({url, rel, refUpdate}) => {
                for await (const {data} of this.paginateAllOver(
                    url,
                    {
                        'expansions': 'pinned_tweet_id',
                        'max_results': 1000,
                        'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld',
                    }
                )) {

                    for (const follow of data) {
                        if (_mostRecent.length !== 1) {
                            _mostRecent.push(follow?.id)
                        }

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

                await prisma.twitterUser.update({
                    where: {
                        id: userId
                    },
                    data: {
                        ...refUpdate(_mostRecent[0])
                    }
                })

                _mostRecent = []

            }
        )) {
        }

        follows = uniqWith(follows, isEqual)

        return follows
    }

    storeConversation = async (participantsIds) => {
        const conversationId = TwitterData2.generateConversationId(participantsIds)

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
                    for (const participantId of participantsIds) {
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

                for (const {id, text, sender_id, event_type, created_at} of data) {
                    const _uoc = {
                        id: id,
                        text: text,
                        senderId: sender_id,
                        eventType: event_type,
                        createdAt: created_at,
                        dmConversation: {
                            connect: {
                                id: conversationId
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

        for await (const _ of TwitterData2.asyncIterWithCallback(
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

                    if (data) {
                        for (const tweet of data) {
                            await callback(userId, tweet)
                        }
                    }

                    if (includes) {
                        for (const key in includes) {
                            for (const {id, media_key, ...data} of includes[key]) {
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
        )) {}

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
        const searchParams = {
            'expansions': 'pinned_tweet_id',
            'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld',
        }

        if (this.userContext) {
            return await this.userContext.makeAPIRequest(
                'GET',
                `https://api.twitter.com/2/users/${userId}`,
                searchParams
            )
        } else {
            const twitter = new Client(await this.getAccessToken())

            return await twitter.users.findUserById(
                userId,
                searchParams
            )
        }
    }

    static generateConversationId = (ids = []) => ids.sort().join("-")

    static asyncIterWithCallback = async function* (iter, callback = async (item) => {
    }, counter = 0) {
        const item = iter[counter]

        yield item

        try {
            await callback(item)
        } catch (e) {
            console.log(e)
        }

        counter++

        if (counter < iter?.length) {
            for await (const item of TwitterData2.asyncIterWithCallback(iter, callback, counter)) {
                yield item
            }
        } else {
            return null
        }
    }

    paginateAllOver = async function* (url, searchParams, callback = async (page) => {
    }, nextToken = true) {

        const page = await this.userContext.makeAPIRequest(
            'GET',
            url,
            searchParams
        )

        const {data, meta} = page

        nextToken = meta?.next_token

        if (data) {
            try {
                if (await callback(page)) {
                    return null
                }
            } catch (e) {
                console.log(e)
            }

            yield page
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

    refreshPollFollows = async (userId = this.userId) => {
        let follows = []

        const {mostRecentFollowerId, mostRecentFollowingId} = await prisma.twitterUser.findUnique({
            where: {
                id: userId
            }
        })

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
                }),
                ref: mostRecentFollowerId,
                refUpdate: (mostRecentFollowerId) => ({
                    mostRecentFollowerId: mostRecentFollowerId
                }),
                followRel: (followId) => ({
                    followers: {
                        some: {
                            id: followId
                        }
                    }
                }),
                friendshipString: 'followed_by'
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
                }),
                ref: mostRecentFollowingId,
                refUpdate: (mostRecentFollowingId) => ({
                    mostRecentFollowingId: mostRecentFollowingId
                }),
                followRel: (followId) => ({
                    followings: {
                        some: {
                            id: followId
                        }
                    }
                }),
                friendshipString: 'following'
            }
        ]

        for await (const _ of TwitterData2.asyncIterWithCallback(
            operations,
            async ({url, rel, ref, refUpdate, friendshipString, followRel}) => {

                const [{connections}] = ref ? await this.userContext.makeAPIRequest(
                    'GET',
                    'https://api.twitter.com/1.1/friendships/lookup.json',
                    {
                        'user_id': ref
                    }
                ) : [{connections: []}]

                const _mostRecent = []

                const _breakerExists = connections.includes(friendshipString)

                for await (const _ of this.paginateAllOver(
                    url,
                    {
                        'expansions': 'pinned_tweet_id',
                        'max_results': 1000,
                        'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld',
                    },
                    async ({data}) => {
                        for (const follow of data) {

                            if (_mostRecent.length !== 1) {
                                _mostRecent.push(follow?.id)
                                await prisma.twitterUser.update({
                                    where: {
                                        id: userId
                                    },
                                    data: {
                                        ...refUpdate(_mostRecent[0])
                                    }
                                })
                            }

                            if (
                                follow?.id === ref ||
                                (
                                    !_breakerExists ?
                                        (
                                            await prisma.twitterUser.findMany({
                                                where: {
                                                    id: userId,
                                                    ...followRel(follow?.id)
                                                }
                                            })
                                        )[0] : false
                                )
                            ) { return true }

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
                )) {}

            }
        )) {
        }

        follows = uniqWith(follows, isEqual)

        return follows
    }

    removeFollow = async (sourceId, targetId) => {
        const operations = [{
            id: sourceId,
            _uoc: {
                id: sourceId,
                followings: {
                    disconnect: {
                        id: targetId
                    }
                }
            },
            recentChecker: async (user) => {
                if (user.mostRecentFollowingId === targetId) {
                    const {data} = await this.userContext.makeAPIRequest(
                        'GET',
                        `https://api.twitter.com/2/users/${sourceId}/following`,
                        {
                            'max_results': 1,
                        },
                        {data: [{id: undefined}]}
                    )

                    if(data.length > 0) {
                        const [{id: currentMostRecentFollowingId}] = data

                        await prisma.twitterUser.update({
                            where: {
                                id: sourceId
                            },
                            data: {
                                mostRecentFollowingId: currentMostRecentFollowingId
                            }
                        })
                    }

                }
            }
        }, {
            id: targetId,
            _uoc: {
                id: targetId,
                followers: {
                    disconnect: {
                        id: sourceId
                    }
                }
            },
            recentChecker: async (user) => {
                if (user.mostRecentFollowerId === sourceId) {
                    const {data} = await this.userContext.makeAPIRequest(
                        'GET',
                        `https://api.twitter.com/2/users/${targetId}/followers`,
                        {
                            'max_results': 1,
                        },
                        {data: [{id: undefined}]}
                    )

                    if(data.length > 0) {
                        const [{id: currentMostRecentFollowerId}] = data

                        await prisma.twitterUser.update({
                            where: {
                                id: targetId
                            },
                            data: {
                                mostRecentFollowerId: currentMostRecentFollowerId
                            }
                        })
                    }
                }
            }
        }]

        for await (const _ of TwitterData2.asyncIterWithCallback(
            operations,
            async ({id, _uoc, recentChecker}) => {
                await recentChecker(
                    await prisma.twitterUser.upsert({
                        where: {
                            id: id
                        },
                        update: _uoc,
                        create: {
                            id: id
                        }
                    })
                )
            }
        )) {
        }
    }

    storeFollow = async (sourceId, targetId) => {
        const operations = [{
            id: sourceId,
            _uoc: {
                id: sourceId,
                followings: {
                    connectOrCreate: {
                        where: {
                            id: targetId
                        },
                        create: {
                            id: targetId
                        }
                    }
                }
            }
        }, {
            id: targetId,
            _uoc: {
                id: targetId,
                followers: {
                    connectOrCreate: {
                        where: {
                            id: sourceId
                        },
                        create: {
                            id: sourceId
                        }
                    }
                }
            }
        }]

        for await (const _ of TwitterData2.asyncIterWithCallback(
            operations,
            async ({id, _uoc}) => {

                await prisma.twitterUser.upsert({
                    where: {
                        id: id
                    },
                    update: _uoc,
                    create: {
                        ..._uoc,
                        ...{
                            data: (await this.getUserData(id))?.data
                        }
                    }
                })
            }
        )) {
        }
    }

    refreshPollTweets = async (userId = this.userId) => {
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

            await prisma.twitterTweet.update({
                where: {
                    id: id
                },
                data: {
                    text: text,
                    createdAt: created_at,
                    data: tweet
                }
            })
        }

        const operations = [
            {
                url: `https://api.twitter.com/2/users/${userId}/tweets`,
                searchParams: {
                    "expansions": "attachments.poll_ids,attachments.media_keys,author_id,edit_history_tweet_ids,entities.mentions.username,geo.place_id,in_reply_to_user_id,referenced_tweets.id,referenced_tweets.id.author_id",
                    "max_results": 100,
                    "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width,public_metrics,alt_text,variants",
                    "place.fields": "contained_within,country,country_code,full_name,geo,id,name,place_type",
                    "poll.fields": "duration_minutes,end_datetime,id,options,voting_status",
                    "tweet.fields": "attachments,author_id,context_annotations,conversation_id,created_at,edit_controls,entities,geo,id,in_reply_to_user_id,lang,public_metrics,possibly_sensitive,referenced_tweets,reply_settings,source,text,withheld",
                    "user.fields": "created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,verified_type,withheld",
                },
                callback: async (userId, tweet) => {
                    await saveAuthorWithTweet(tweet)
                },
                ref: (
                    await prisma.twitterUser.findUnique({
                        select: {
                            tweets: {
                                orderBy: {
                                    createdAt: 'desc'
                                },
                                take: 1
                            }
                        },
                        where: {
                            id: userId
                        }
                    })
                ).tweets[0]?.id,
                breaker: async (tweet) => (
                    (await prisma.twitterUser.findMany({
                        where: {
                            id: userId,
                            tweets: {
                                some: {
                                    id: tweet.id
                                }
                            }
                        }
                    }))[0]
                )
            },
            {
                url: `https://api.twitter.com/2/users/${userId}/mentions`,
                searchParams: {
                    "expansions": "attachments.poll_ids,attachments.media_keys,author_id,edit_history_tweet_ids,entities.mentions.username,geo.place_id,in_reply_to_user_id,referenced_tweets.id,referenced_tweets.id.author_id",
                    "max_results": 100,
                    "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width,public_metrics,alt_text,variants",
                    "place.fields": "contained_within,country,country_code,full_name,geo,id,name,place_type",
                    "poll.fields": "duration_minutes,end_datetime,id,options,voting_status",
                    "tweet.fields": "attachments,author_id,context_annotations,conversation_id,created_at,edit_controls,entities,geo,id,in_reply_to_user_id,lang,public_metrics,possibly_sensitive,referenced_tweets,reply_settings,source,text,withheld",
                    "user.fields": "created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,verified_type,withheld",
                },
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
                },
                ref: (
                    await prisma.twitterUser.findUnique({
                        select: {
                            mentions: {
                                orderBy: {
                                    createdAt: 'desc'
                                },
                                take: 1
                            }
                        },
                        where: {
                            id: userId
                        }
                    })
                ).mentions[0]?.id,
                breaker: async (tweet) => (
                    (await prisma.twitterUser.findMany({
                        where: {
                            id: userId,
                            mentions: {
                                some: {
                                    id: tweet.id
                                }
                            }
                        }
                    }))[0]
                )
            },
            {
                url: `https://api.twitter.com/2/users/${userId}/liked_tweets`,
                searchParams: {
                    "expansions": "attachments.poll_ids,attachments.media_keys,author_id,edit_history_tweet_ids,entities.mentions.username,geo.place_id,in_reply_to_user_id,referenced_tweets.id,referenced_tweets.id.author_id",
                    "max_results": 100,
                    "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width,public_metrics,alt_text,variants",
                    "place.fields": "contained_within,country,country_code,full_name,geo,id,name,place_type",
                    "poll.fields": "duration_minutes,end_datetime,id,options,voting_status",
                    "tweet.fields": "attachments,author_id,context_annotations,conversation_id,created_at,edit_controls,entities,geo,id,in_reply_to_user_id,lang,public_metrics,possibly_sensitive,referenced_tweets,reply_settings,source,text,withheld",
                    "user.fields": "created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,verified_type,withheld",
                },
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
                },
                ref: null,
                breaker: async (tweet) => (
                    (await prisma.twitterUser.findMany({
                        where: {
                            id: userId,
                            liked: {
                                some: {
                                    id: tweet.id
                                }
                            }
                        }
                    }))[0]
                )
            }
        ]

        const _includesDictionary = {
            "users": "user",
            "tweets": "tweet",
            "media": "media",
            "places": "place",
            "polls": "poll"
        }

        for await (const _ of TwitterData2.asyncIterWithCallback(
            operations,
            async ({url, searchParams, callback, ref, breaker}) => {
                console.log(`>>> Operation on: ${url} <<<`, ref)
                for await (const _ of this.paginateAllOver(
                    url,
                    searchParams,
                    async ({data, includes}) => {

                        if (includes) {
                            for (const key in includes) {
                                for (const {id, media_key, ...data} of includes[key]) {
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

                        if (data) {
                            // console.log(data)

                            for (const tweet of data) {
                                await callback(userId, tweet)

                                if(ref ? tweet.id === ref : await breaker(tweet)) {
                                    return true
                                }
                            }
                        }
                    }
                )) {}
            }
        )) {}
    }

    refreshPollConversation = async (participantsIds) => {
        const conversationId = TwitterData2.generateConversationId(participantsIds)
        const breaker = (await prisma.twitterDMConversation.findUnique({
            select: {
                messages: {
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 1
                }
            },
            where: {
                id: conversationId
            }
        })).messages[0]?.id

        let conversationStored;

        for await (const _ of this.paginateAllOver(
            `https://api.twitter.com/2/dm_conversations/${conversationId}/dm_events`,
            {
                'dm_event.fields': 'id,text,event_type,created_at,dm_conversation_id,sender_id,participant_ids,referenced_tweets,attachments',
                'event_types': 'MessageCreate,ParticipantsJoin,ParticipantsLeave',
                'expansions': 'attachments.media_keys,referenced_tweets.id,sender_id,participant_ids',
                'max_results': 100,
                'media.fields': 'duration_ms,height,media_key,preview_image_url,type,url,width,public_metrics,alt_text,variants',
                'tweet.fields': 'attachments,author_id,context_annotations,conversation_id,created_at,edit_controls,entities,geo,id,in_reply_to_user_id,lang,public_metrics,possibly_sensitive,referenced_tweets,reply_settings,source,text,withheld',
                'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld',
            },
            async ({data, includes}) => {

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
                        for (const participantId of participantsIds) {
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

                    /**
                     * Save messages
                     * */

                    for (const {id, text, sender_id, event_type, created_at} of data) {
                        const _uoc = {
                            id: id,
                            text: text,
                            senderId: sender_id,
                            eventType: event_type,
                            createdAt: created_at,
                            dmConversation: {
                                connect: {
                                    id: conversationId
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

                        if(breaker === id) {
                            return true
                        }
                    }

                }
            }
        )) {}
    }

}

const sortQueryString = (queryString) => {
    const _parsedQueryString = querystring.parse(queryString)
    return querystring.stringify(
        Object.fromEntries(
            Object.keys(_parsedQueryString)
                .sort()
                .map(v => [v, _parsedQueryString[v]])
        )
    )
}

export const createOAuthSignature = (
    {
        method,
        url,
        queryString = "",
        bodyQueryString = "",
        oauthConsumerKey,
        oauthNonce = crypto.randomBytes(32).toString('hex'),
        oauthSignatureMethod = 'HMAC-SHA1',
        oauthTimestamp = Math.ceil(Date.now() / 1000),
        oauthToken,
        oauthVersion = '1.0',
        oauthConsumerSecret,
        oauthTokenSecret
    }
) => {

    const parameterString =
        sortQueryString(
            `${queryString}&${bodyQueryString}&oauth_consumer_key=${oauthConsumerKey}&oauth_nonce=${oauthNonce}&oauth_signature_method=${oauthSignatureMethod}&oauth_timestamp=${oauthTimestamp}&oauth_token=${oauthToken}&oauth_version=${oauthVersion}`
        )

    console.log(parameterString)

    const signatureBaseString = encodeURIComponent(method.toUpperCase()) + "&" + encodeURIComponent(url) + "&" + encodeURIComponent(parameterString)

    console.log(signatureBaseString)

    const signingKey = encodeURIComponent(oauthConsumerSecret) + "&" + encodeURIComponent(oauthTokenSecret)

    console.log(signingKey)

    const signature = crypto.createHmac('sha1', signingKey).update(signatureBaseString).digest('base64')

    console.log(signature)

    return signature
}

export const createOAuthHeaderString = (
    {
        method,
        url,
        queryString = "",
        bodyQueryString = "",
        oauthConsumerKey,
        oauthNonce = crypto.randomBytes(32).toString('base64'),
        oauthSignatureMethod = 'HMAC-SHA1',
        oauthTimestamp = Math.ceil(Date.now() / 1000),
        oauthToken,
        oauthVersion = '1.0',
        oauthConsumerSecret,
        oauthTokenSecret
    }
) => {
    const _components = {
        oauth_consumer_key: oauthConsumerKey,
        oauth_nonce: oauthNonce,
        oauth_signature: createOAuthSignature({
            method: method,
            url: url,
            queryString: queryString,
            bodyQueryString: bodyQueryString,
            oauthConsumerKey: oauthConsumerKey,
            oauthNonce: oauthNonce,
            oauthSignatureMethod: oauthSignatureMethod,
            oauthTimestamp: oauthTimestamp,
            oauthToken: oauthToken,
            oauthVersion: oauthVersion,
            oauthConsumerSecret: oauthConsumerSecret,
            oauthTokenSecret: oauthTokenSecret
        }),
        oauth_signature_method: oauthSignatureMethod,
        oauth_timestamp: oauthTimestamp,
        oauth_token: oauthToken,
        oauth_version: oauthVersion
    }

    const headerString = (
        'OAuth ' +
        Object.entries(_components).map(
            ([key, value]) => `${encodeURIComponent(key)}="${encodeURIComponent(value)}"`
        ).join(', ')
    )

    console.log(headerString)

    return headerString
}