#include <vulkan/vulkan.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr,"check failed at line %d: %s\n",__LINE__,#x); exit(1); } } while (0)
#define VK(x) do { VkResult vk_result_=(x); if (vk_result_!=VK_SUCCESS) { fprintf(stderr,"vulkan error %d at line %d\n",vk_result_,__LINE__); exit(1); } } while (0)

typedef struct { VkBuffer buffer; VkDeviceMemory memory; uint32_t *mapped; size_t size; } Storage;

static void *read_file(const char *path,size_t *size) {
 FILE *file=fopen(path,"rb"); CHECK(file); CHECK(!fseek(file,0,SEEK_END));
 long length=ftell(file); CHECK(length>0&&length<8*1024*1024); rewind(file);
 void *data=malloc((size_t)length); CHECK(data&&fread(data,1,(size_t)length,file)==(size_t)length);
 fclose(file); *size=(size_t)length; return data;
}

static Storage storage(VkDevice device,VkPhysicalDevice physical,size_t size) {
 Storage result={.size=size};
 VkBufferCreateInfo info={.sType=VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,.size=size,.usage=VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,.sharingMode=VK_SHARING_MODE_EXCLUSIVE};
 VK(vkCreateBuffer(device,&info,0,&result.buffer));
 VkMemoryRequirements req; vkGetBufferMemoryRequirements(device,result.buffer,&req);
 VkPhysicalDeviceMemoryProperties props; vkGetPhysicalDeviceMemoryProperties(physical,&props);
 uint32_t type=0; while(type<props.memoryTypeCount&&(!(req.memoryTypeBits&(1u<<type))||(props.memoryTypes[type].propertyFlags&(VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT))!=(VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)))type++;
 CHECK(type<props.memoryTypeCount);
 VkMemoryAllocateInfo alloc={.sType=VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,.allocationSize=req.size,.memoryTypeIndex=type};
 VK(vkAllocateMemory(device,&alloc,0,&result.memory)); VK(vkBindBufferMemory(device,result.buffer,result.memory,0));
 VK(vkMapMemory(device,result.memory,0,size,0,(void**)&result.mapped)); memset(result.mapped,0,size);
 return result;
}

int main(int argc,char **argv) {
 CHECK(argc==5);
 unsigned frames=(unsigned)strtoul(argv[3],0,10); CHECK(frames>0&&frames<600);
 size_t imageSize,shaderSize; void *image=read_file(argv[2],&imageSize),*shader=read_file(argv[1],&shaderSize);
 CHECK(shaderSize%4==0&&imageSize%4==0);
 VkApplicationInfo app={.sType=VK_STRUCTURE_TYPE_APPLICATION_INFO,.pApplicationName="MintNES offline check",.apiVersion=VK_API_VERSION_1_0};
 const char *instanceExtensions[]={VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME};
 VkInstanceCreateInfo instanceInfo={.sType=VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,.pApplicationInfo=&app,.flags=VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR,.enabledExtensionCount=1,.ppEnabledExtensionNames=instanceExtensions};
 VkInstance instance; VK(vkCreateInstance(&instanceInfo,0,&instance));
 uint32_t deviceCount=0; VK(vkEnumeratePhysicalDevices(instance,&deviceCount,0)); CHECK(deviceCount>0&&deviceCount<16);
 VkPhysicalDevice physicals[16]; VK(vkEnumeratePhysicalDevices(instance,&deviceCount,physicals));
 VkPhysicalDevice physical=physicals[0];
 uint32_t familyCount=0; vkGetPhysicalDeviceQueueFamilyProperties(physical,&familyCount,0); CHECK(familyCount<64);
 VkQueueFamilyProperties families[64]; vkGetPhysicalDeviceQueueFamilyProperties(physical,&familyCount,families);
 uint32_t family=0; while(family<familyCount&&!(families[family].queueFlags&VK_QUEUE_COMPUTE_BIT))family++; CHECK(family<familyCount);
 float priority=1.0f; VkDeviceQueueCreateInfo queueInfo={.sType=VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,.queueFamilyIndex=family,.queueCount=1,.pQueuePriorities=&priority};
 VkDeviceCreateInfo deviceInfo={.sType=VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,.queueCreateInfoCount=1,.pQueueCreateInfos=&queueInfo};
 VkDevice device; VK(vkCreateDevice(physical,&deviceInfo,0,&device)); VkQueue queue; vkGetDeviceQueue(device,family,0,&queue);
 Storage controls=storage(device,physical,8*1024*1024),memory=storage(device,physical,imageSize);
 memcpy(memory.mapped,image,imageSize); free(image);
 if(!getenv("MINTNES_MENU_SCENARIO"))memory.mapped[19]=0;
 VkDescriptorSetLayoutBinding bindings[2]={{.binding=0,.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,.descriptorCount=1,.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT},{.binding=1,.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,.descriptorCount=1,.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT}};
 VkDescriptorSetLayoutCreateInfo setInfo={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,.bindingCount=2,.pBindings=bindings};
 VkDescriptorSetLayout setLayout; VK(vkCreateDescriptorSetLayout(device,&setInfo,0,&setLayout));
 VkPipelineLayoutCreateInfo layoutInfo={.sType=VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,.setLayoutCount=1,.pSetLayouts=&setLayout};
 VkPipelineLayout layout; VK(vkCreatePipelineLayout(device,&layoutInfo,0,&layout));
 VkShaderModuleCreateInfo moduleInfo={.sType=VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,.codeSize=shaderSize,.pCode=shader};
 VkShaderModule module; VK(vkCreateShaderModule(device,&moduleInfo,0,&module)); free(shader);
 VkComputePipelineCreateInfo pipelineInfo={.sType=VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,.layout=layout,.stage={.sType=VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,.stage=VK_SHADER_STAGE_COMPUTE_BIT,.module=module,.pName="main"}};
 VkPipeline pipeline; VK(vkCreateComputePipelines(device,0,1,&pipelineInfo,0,&pipeline));
 VkDescriptorPoolSize poolSize={VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,2};
 VkDescriptorPoolCreateInfo poolInfo={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,.maxSets=1,.poolSizeCount=1,.pPoolSizes=&poolSize};
 VkDescriptorPool pool; VK(vkCreateDescriptorPool(device,&poolInfo,0,&pool));
 VkDescriptorSetAllocateInfo setAlloc={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,.descriptorPool=pool,.descriptorSetCount=1,.pSetLayouts=&setLayout};
 VkDescriptorSet set; VK(vkAllocateDescriptorSets(device,&setAlloc,&set));
 VkDescriptorBufferInfo bufferInfos[2]={{controls.buffer,0,controls.size},{memory.buffer,0,memory.size}};
 VkWriteDescriptorSet writes[2]={{.sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,.dstSet=set,.dstBinding=0,.descriptorCount=1,.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,.pBufferInfo=&bufferInfos[0]},{.sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,.dstSet=set,.dstBinding=1,.descriptorCount=1,.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,.pBufferInfo=&bufferInfos[1]}};
 vkUpdateDescriptorSets(device,2,writes,0,0);
 VkCommandPoolCreateInfo commandPoolInfo={.sType=VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,.queueFamilyIndex=family};
 VkCommandPool commandPool; VK(vkCreateCommandPool(device,&commandPoolInfo,0,&commandPool));
 VkCommandBufferAllocateInfo commandInfo={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,.commandPool=commandPool,.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY,.commandBufferCount=1};
 VkCommandBuffer command; VK(vkAllocateCommandBuffers(device,&commandInfo,&command));
 VkCommandBufferBeginInfo begin={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO}; VK(vkBeginCommandBuffer(command,&begin));
 vkCmdBindDescriptorSets(command,VK_PIPELINE_BIND_POINT_COMPUTE,layout,0,1,&set,0,0); vkCmdBindPipeline(command,VK_PIPELINE_BIND_POINT_COMPUTE,pipeline); vkCmdDispatch(command,1,1,1); VK(vkEndCommandBuffer(command));
 VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&command};
 struct timespec start,end; clock_gettime(CLOCK_MONOTONIC,&start);
 int winScenario=getenv("MINTNES_WIN_SCENARIO")!=0;
 int menuScenario=getenv("MINTNES_MENU_SCENARIO")!=0,minusScenario=getenv("MINTNES_MINUS_SCENARIO")!=0,bScenario=getenv("MINTNES_B_SCENARIO")!=0;
 for(unsigned frame=0;frame<frames;frame++){
  controls.mapped[2]=menuScenario?(frame==0?1u:0u):minusScenario?(frame==30?2048u:0u):bScenario?(frame==30?2u:0u):winScenario?(frame>=30&&frame<95?16384u:frame>=95&&frame<128?32768u:frame==132?1024u:0u):(frame>=30&&frame<35?16384u:0u);
  controls.mapped[8]=1u;
  VK(vkQueueSubmit(queue,1,&submit,0)); VK(vkQueueWaitIdle(queue));
 }
 clock_gettime(CLOCK_MONOTONIC,&end);
 FILE *output=fopen(argv[4],"wb"); CHECK(output&&fwrite(memory.mapped,1,imageSize,output)==imageSize); fclose(output);
 double elapsed=(double)(end.tv_sec-start.tv_sec)+(double)(end.tv_nsec-start.tv_nsec)*1e-9;
 printf("{\"frames\":%u,\"seconds\":%.6f,\"consoleExecuted\":false}\n",frames,elapsed);
 VK(vkDeviceWaitIdle(device));
 vkDestroyCommandPool(device,commandPool,0); vkDestroyDescriptorPool(device,pool,0); vkDestroyPipeline(device,pipeline,0); vkDestroyShaderModule(device,module,0); vkDestroyPipelineLayout(device,layout,0); vkDestroyDescriptorSetLayout(device,setLayout,0);
 vkUnmapMemory(device,controls.memory); vkUnmapMemory(device,memory.memory);
 vkDestroyBuffer(device,controls.buffer,0); vkDestroyBuffer(device,memory.buffer,0);
 vkFreeMemory(device,controls.memory,0); vkFreeMemory(device,memory.memory,0); vkDestroyDevice(device,0); vkDestroyInstance(instance,0);
 return 0;
}
