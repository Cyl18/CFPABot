# syntax=docker/dockerfile:1
#See https://aka.ms/containerfastmode to understand how Visual Studio uses this Dockerfile to build your images for faster debugging.

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone
RUN apt -y update && apt install -y git && apt install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
EXPOSE 80

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS publish
WORKDIR /root/src
COPY ["CFPABot/CFPABot.csproj", "CFPABot/"]
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore "CFPABot/CFPABot.csproj" 
COPY . .
WORKDIR "/root/src/CFPABot"
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    --mount=type=cache,id=obj,target=/root/src/CFPABot/obj \
    --mount=type=cache,id=bin,target=/root/src/CFPABot/bin \
    dotnet publish "CFPABot.csproj" -c Debug -o /app/publish --no-restore

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENV LD_LIBRARY_PATH=/app/runtimes/linux-x64/native/
HEALTHCHECK --interval=5s --timeout=10s --retries=3 CMD curl --fail http://127.0.0.1:8080/healthcheck || exit 1
ENTRYPOINT ["dotnet", "CFPABot.dll"]