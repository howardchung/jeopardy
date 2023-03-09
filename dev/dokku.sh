#!/bin/bash

# for debian systems, installs Dokku via apt-get
wget https://dokku.com/install/v0.30.1/bootstrap.sh
sudo DOKKU_TAG=v0.30.1 bash bootstrap.sh

# usually your key is already available under the current user's `~/.ssh/authorized_keys` file
cat ~/.ssh/authorized_keys | sudo dokku ssh-keys:add admin

# you can use any domain you already have access to
# this domain should have an A record or CNAME pointing at your server's IP
dokku domains:set-global jeopardy.app

dokku apps:create jeopardy.app
# Set up env vars
# dokku config:set jeopardy.app STATS_KEY=test
# Use the IP of the docker bridge network
dokku config:set jeopardy.app REDIS_URL=redis://172.17.0.4:6379

# Set up redis
sudo docker run --name redis -d redis:7