#!/bin/bash

# for debian systems, installs Dokku via apt-get
wget https://dokku.com/install/v0.30.1/bootstrap.sh
sudo DOKKU_TAG=v0.30.1 bash bootstrap.sh

# usually your key is already available under the current user's `~/.ssh/authorized_keys` file
cat ~/.ssh/authorized_keys | sudo dokku ssh-keys:add admin

# you can use any domain you already have access to
# this domain should have an A record or CNAME pointing at your server's IP
dokku domains:set-global jeopardy.centralus.cloudapp.azure.com

dokku apps:create jeopardy
# Set up env vars
# dokku config:set jeopardy STATS_KEY=test

# Set up redis
sudo docker run --name redis --net=host -d redis:7