#!/usr/bin/env node
import got from "got";
import {TwitterOAuthClient} from "../twitter/index.js";
import TwitterData2 from "../twitter/2/index.js";
import * as fs from "fs";

(async ()=>{
    const twitterAuth = new TwitterOAuthClient({
        oauthConsumerKey: process.env.TWITTER_OAUTH_CONSUMER_KEY,
        oauthConsumerSecret: process.env.TWITTER_OAUTH_CONSUMER_SECRET,
        oauthToken: process.env.TWITTER_OAUTH_TOKEN,
        oauthTokenSecret: process.env.TWITTER_OAUTH_TOKEN_SECRET,
        callback: process.env.TWITTER_CALLBACK
    })

    const { environments: [{ webhooks }] } = await twitterAuth.makeAPIRequest(
        'GET',
        "https://api.twitter.com/1.1/account_activity/all/webhooks.json"
    )

    const { subscriptions } = await got.get(
        'https://api.twitter.com/1.1/account_activity/all/development/subscriptions/list.json',
        {
            headers: {
                'Authorization': `Bearer ${process.env.TWITTER_OAUTH_APP_ACCESS_TOKEN}`
            }
        }
    ).json().catch(({response: {body}}) => {
        console.log(JSON.parse(body))
    })

    if(subscriptions[0]) {
        fs.writeFileSync('./toolkit/subscriptions.json', JSON.stringify(subscriptions))
    }

    for(const {id} of webhooks) {
        await twitterAuth.makeAPIRequest(
            'DELETE',
            `https://api.twitter.com/1.1/account_activity/all/development/webhooks/${id}.json`
        )
    }

    const webhook = await twitterAuth.makeAPIRequest(
        'POST',
        "https://api.twitter.com/1.1/account_activity/all/development/webhooks.json",
        {
            url: process.env.TWITTER_WEBHOOKS_REGISTERATION_URL
        }
    )

    const _subscriptions = subscriptions[0] ? subscriptions : JSON.parse(fs.readFileSync("./toolkit/subscriptions.json").toString())

    if(_subscriptions[0]) {
        for await (const _ of TwitterData2.asyncIterWithCallback(
            _subscriptions,
            async ({user_id: userId}) => {
                const {token, tokenSecret} = await TwitterOAuthClient.getStoredAccessToken(userId)

                await twitterAuth.userContext(
                    token,
                    tokenSecret
                ).makeAPIRequest(
                    'POST',
                    "https://api.twitter.com/1.1/account_activity/all/development/subscriptions.json"
                )
            }
        )) {}
    }



    console.log(webhook)
})();