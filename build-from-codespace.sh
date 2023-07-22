git pull
docker build -f "CFPABot/Dockerfile" --force-rm -t docker.cyan.cafe/cfpabot .
docker image push docker.cyan.cafe/cfpabot:latest